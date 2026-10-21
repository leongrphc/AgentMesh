import { randomUUID } from "node:crypto";
import { safeLog } from "./safe-log.js";
import { PermissionBroker, type PermissionDecision } from "./permissions.js";
import type {
  AgentAdapter,
  AgentMessage,
  AgentOutput,
  AgentResult,
  AgentTask,
  DomainEvent,
  Fact,
  Project,
  StoredEvent,
  TaskRecord,
  MessageDraft,
  MessageDelivery,
  ContextConflict,
  ContextChoice,
} from "./contracts.js";
import type { EventStore } from "./journal.js";
import type { WorktreeManager } from "./worktrees.js";
import { MergeConflictError } from "./worktrees.js";
import type { AgentConfig } from "./config.js";
import { validate } from "./config.js";
import { validateAgentEdit } from "./agent-settings.js";
import { normalizeTestReports } from "./test-reports.js";
import { ExecutionInbox, validateMessageDraft } from "./inbox.js";
import { normalizeContextFacts } from "./context.js";
import { validateContextKeys } from "./context.js";
import { prepareContext } from "./context-package.js";
import { historyPage } from "./history-page.js";
import { eventStream } from "./journal.js";
import { materializeHistory } from "./materialize-history.js";

export interface ProjectSnapshot {
  project: Project;
  tasks: TaskRecord[];
  context: Record<string, Fact>;
  contextHistory: Record<string, Fact[]>;
  contextConflicts: ContextConflict[];
  messages: AgentMessage[];
  deliveries: MessageDelivery[];
  inboxes: Array<{ taskId: string; cursor: number; pending: number; uncertain: number }>;
}

/** Live notifications are ephemeral; domain events are additionally kept in the journal. */
export type OrchestratorNotice =
  | { kind: "event"; event: StoredEvent }
  | { kind: "output"; projectId: string; taskId: string; output: AgentOutput };

type RetainedMessage = Omit<AgentMessage, "body"> & ({ body: string; eventId?: never } | { body?: never; eventId: string });

export class Orchestrator {
  private readonly projects = new Map<string, Project>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly facts = new Map<string, Map<string, Fact>>();
  private readonly factHistory = new Map<string, Map<string, Fact[]>>();
  private readonly contextConflicts = new Map<string, Map<string, ContextConflict>>();
  private readonly resolvedContext = new Map<string, ContextConflict[]>();
  private readonly messages: RetainedMessage[] = [];
  private readonly deliveries = new Map<string, MessageDelivery>();
  private readonly inboxes = new Map<string, ExecutionInbox>();
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly agentSettings = new Map<string, AgentConfig[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly subscribers = new Set<(notice: OrchestratorNotice) => void>();
  private readonly permissions: PermissionBroker;
  private readonly diskHistory: boolean;
  private readonly diskDeliveries: boolean;
  private readonly diskMessages: boolean;
  private readonly packageCounts = new Map<string, number>();
  private readonly resolvedCounts = new Map<string, number>();
  private lastAppliedId: string | null = null;

  constructor(private readonly journal: EventStore, private readonly worktrees?: WorktreeManager) {
    this.diskHistory = !!(journal.scan && journal.contextHistoryPage && journal.contextPackagesPage && journal.resolvedContextPage);
    this.diskDeliveries = !!(journal.readDelivery && journal.scanDeliveries);
    this.diskMessages = !!(journal.readEvent && journal.scanMessageReferences && journal.messageReferencePage && journal.messageCount && journal.findMessageReference);
    this.permissions = new PermissionBroker((event) => this.emit(event));
    const checkpoint = this.diskHistory && journal.scanAfter ? journal.loadCheckpoint?.() : undefined;
    const restored = checkpoint && this.restoreCheckpoint(checkpoint.state);
    if (restored) this.lastAppliedId = checkpoint.sourceId;
    const unresolved = new Map<string, Extract<DomainEvent, { type: "permission.requested" }>>();
    const events = restored ? journal.scanAfter!(checkpoint.sequence) : eventStream(journal);
    for (const { payload, id } of events) {
      this.apply(payload, id);
      this.lastAppliedId = id;
      if (payload.type === "permission.requested") unresolved.set(payload.requestId, payload);
      if (payload.type === "permission.resolved") unresolved.delete(payload.requestId);
    }
    for (const delivery of this.deliveries.values()) if (delivery.status === "sending") {
      const task = this.requireTask(delivery.taskId);
      this.emit({ type: "message.delivery", projectId: task.projectId, delivery: { ...delivery, status: "uncertain" } });
    }
    for (const request of unresolved.values()) this.emit({ type: "permission.resolved", projectId: request.projectId,
      taskId: request.taskId, executionId: request.executionId, requestId: request.requestId, decision: "deny", source: "restart" });
    // Çökme sonrası aynı komutları otomatik tekrar çalıştırmak tehlikeli olabilir.
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.emit({ type: "task.interrupted", projectId: task.projectId, taskId: task.id });
      }
    }
  }

  checkpoint() {
    if (!this.diskHistory || !this.journal.saveCheckpoint) throw new Error("Bu journal checkpoint desteklemiyor");
    if (this.controllers.size || this.inboxes.size || [...this.tasks.values()].some(task => task.status === "running")
      || [...this.projects.keys()].some(id => this.pendingPermissions(id).length)) throw new Error("Checkpoint için çalışan görevleri bitirin");
    const state = { version: 4, diskMessages: this.diskMessages, diskDeliveries: this.diskDeliveries, projects: [...this.projects], tasks: [...this.tasks],
      facts: [...this.facts].map(([id, values]) => [id, [...values]]),
      conflicts: [...this.contextConflicts].map(([id, values]) => [id, [...values]]),
      messages: this.messages, deliveries: [...this.deliveries], agentSettings: [...this.agentSettings],
      packageCounts: [...this.packageCounts], resolvedCounts: [...this.resolvedCounts] };
    return this.journal.saveCheckpoint(JSON.stringify(state), this.lastAppliedId);
  }

  private restoreCheckpoint(serialized: string): boolean {
    try {
      const state = JSON.parse(serialized);
      const names = ["projects", "tasks", "facts", "conflicts", "messages", "deliveries", "agentSettings", "packageCounts", "resolvedCounts"];
      if (state?.version !== 4 || state.diskMessages !== this.diskMessages || state.diskDeliveries !== this.diskDeliveries || names.some(name => !Array.isArray(state[name]))) return false;
      if (this.diskMessages && state.messages.length) return false;
      const pairs = (entries: unknown): Array<[string, any]> => {
        if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
          || new Set(entries.map(entry => entry[0])).size !== entries.length) throw new Error("Geçersiz checkpoint haritası");
        return entries;
      };
      for (const [key, value] of pairs(state.projects)) {
        if (value?.id !== key || typeof value.workspaceRoot !== "string") throw new Error("Geçersiz checkpoint projesi");
        this.projects.set(key, value);
      }
      for (const [key, value] of pairs(state.tasks)) {
        if (value?.id !== key || !this.projects.has(value.projectId) || !Array.isArray(value.dependsOn) || !Array.isArray(value.allowedPaths)
          || !["pending", "completed", "failed", "blocked", "cancelled", "needs_review", "pending_review"].includes(value.status)) throw new Error("Geçersiz checkpoint görevi");
        this.tasks.set(key, value);
      }
      for (const [id, entries] of pairs(state.facts)) {
        const values = pairs(entries);
        if (!this.projects.has(id) || values.some(([key, value]) => value?.key !== key || !Number.isInteger(value.revision) || value.revision < 1)) throw new Error("Geçersiz checkpoint context");
        this.facts.set(id, new Map(values));
      }
      for (const [id, entries] of pairs(state.conflicts)) {
        const values = pairs(entries);
        if (!this.projects.has(id) || values.some(([key, value]) => value?.id !== key || value.status !== "pending")) throw new Error("Geçersiz checkpoint kararı");
        this.contextConflicts.set(id, new Map(values));
      }
      for (const entry of state.messages) {
        if (!entry || typeof entry.id !== "string" || !this.projects.has(entry.projectId)) throw new Error("Geçersiz checkpoint mesajı");
        if (entry.eventId !== undefined ? typeof entry.eventId !== "string" || !this.journal.readEvent || entry.body !== undefined : typeof entry.body !== "string") throw new Error("Geçersiz checkpoint mesaj kaynağı");
        this.messages.push(entry);
      }
      for (const [key, value] of pairs(state.deliveries)) {
        if (!value || !this.tasks.has(value.taskId) || !["sending", "accepted", "uncertain", "queued"].includes(value.status)) throw new Error("Geçersiz checkpoint teslimi");
        if (this.diskDeliveries && value.status !== "sending") throw new Error("Geçersiz checkpoint aktif teslimi");
        this.deliveries.set(key, value);
      }
      for (const [key, value] of pairs(state.agentSettings)) {
        if (!this.projects.has(key) || !Array.isArray(value)) throw new Error("Geçersiz checkpoint ajanları");
        this.agentSettings.set(key, value);
      }
      for (const [target, entries] of [[this.packageCounts, state.packageCounts], [this.resolvedCounts, state.resolvedCounts]] as const) {
        for (const [key, value] of pairs(entries)) {
          if (!Number.isSafeInteger(value) || value < 0) throw new Error("Geçersiz checkpoint sayısı");
          target.set(key, value);
        }
      }
      return true;
    } catch {
      for (const map of [this.projects, this.tasks, this.facts, this.contextConflicts, this.deliveries, this.agentSettings, this.packageCounts, this.resolvedCounts]) map.clear();
      this.messages.length = 0;
      return false;
    }
  }

  registerAgent(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Ajan zaten kayıtlı: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  configureAgents(projectId: string, agents: AgentConfig[], sourceAgents: AgentConfig[]): void {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    if (this.controllers.size) throw new Error("Önce çalışan görevleri durdurun");
    const snapshot = this.snapshot(projectId, false);
    validate({ projectId, repoPath: snapshot.project.workspaceRoot, agents, tasks: snapshot.tasks });
    for (const agent of agents) validateAgentEdit(this.agentSettings.get(projectId) ?? [], agent, snapshot.tasks);
    this.emit({ type: "project.agents.configured", projectId, agents: structuredClone(agents), sourceAgents: structuredClone(sourceAgents) });
  }

  replaceAgent(adapter: AgentAdapter): void {
    if (this.controllers.size) throw new Error("Önce çalışan görevleri durdurun");
    this.adapters.set(adapter.id, adapter);
  }

  pendingPermissions(projectId: string) { return this.permissions.list(projectId); }

  decidePermission(projectId: string, requestId: string, executionId: string, digest: string, decision: PermissionDecision) {
    this.permissions.decide(projectId, requestId, executionId, digest, decision);
  }

  subscribe(listener: (notice: OrchestratorNotice) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  private notify(notice: OrchestratorNotice): void {
    for (const listener of this.subscribers) {
      try { listener(notice); } catch { /* Observer errors must not modify task state. */ }
    }
  }

  /** Cancels queued work immediately and signals any active adapter to stop. */
  cancelTask(taskId: string): void {
    const task = this.requireTask(taskId);
    if (task.status !== "pending" && task.status !== "running") {
      throw new Error(`Görev iptal edilemez: ${task.status}`);
    }
    this.emit({ type: "task.cancelled", projectId: task.projectId, taskId });
    this.controllers.get(taskId)?.abort();
  }

  cancelRunning(projectId: string): void {
    for (const task of this.tasks.values()) {
      if (task.projectId === projectId && task.status === "running") this.cancelTask(task.id);
    }
  }

  createProject(project: Project): void {
    if (this.projects.has(project.id)) throw new Error(`Proje zaten mevcut: ${project.id}`);
    this.emit({ type: "project.created", project });
  }

  setParallelism(projectId: string, maxParallel: number): void {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error("Paralellik 1-8 aralığında olmalı");
    this.emit({ type: "project.parallelism.updated", projectId, maxParallel });
  }

  addTask(task: AgentTask): void {
    validateContextKeys(task.contextKeys);
    if (!this.projects.has(task.projectId)) throw new Error(`Proje bulunamadı: ${task.projectId}`);
    if (this.tasks.has(task.id)) throw new Error(`Görev ID'si zaten mevcut: ${task.id}`);
    if (!this.adapters.has(task.agentId)) throw new Error(`Ajan kayıtlı değil: ${task.agentId}`);
    if (task.dependsOn.includes(task.id)) throw new Error("Görev kendisine bağımlı olamaz");
    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      throw new Error("Tekrarlanan görev bağımlılığı");
    }
    for (const dependencyId of task.dependsOn) {
      const dependency = this.tasks.get(dependencyId);
      if (!dependency || dependency.projectId !== task.projectId) {
        throw new Error(`Geçersiz bağımlılık: ${dependencyId}`);
      }
    }
    this.emit({ type: "task.created", task: structuredClone(task) });
  }

  contextHistoryPage(projectId: string, key: string, before?: number): import("./contracts.js").ContextHistoryPage {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    if (typeof key !== "string" || !key || key.length > 160 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw new Error("Geçersiz context geçmişi isteği");
    if (this.journal.contextHistoryPage) return this.journal.contextHistoryPage(projectId, key, before);
    const history = this.factHistory.get(projectId)?.get(key) ?? [];
    const end = Math.min(history.length, (before ?? history.length + 1) - 1);
    const start = Math.max(0, end - 20);
    return { entries: structuredClone(history.slice(start, end).reverse()), latestRevision: history.length,
      ...(start > 0 ? { nextBefore: start + 1 } : {}) };
  }

  historyCounts(projectId: string) {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    return { messages: this.diskMessages ? this.journal.messageCount!(projectId) : this.messages.filter(message => message.projectId === projectId).length, messageRevision: this.lastAppliedId ?? "",
      resolvedDecisions: this.resolvedCounts.get(projectId) ?? 0,
      contextPackages: Object.fromEntries([...this.tasks.values()].filter(task => task.projectId === projectId).map(task => [task.id, this.packageCounts.get(task.id) ?? 0])) };
  }

  messageHistoryPage(projectId: string, taskId?: string, before?: number): import("./contracts.js").HistoryPage<import("./contracts.js").MessageHistoryEntry> {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    const task = taskId === undefined ? undefined : this.requireTask(taskId);
    if (task && task.projectId !== projectId) throw new Error("Görev başka projeye ait");
    const page = this.diskMessages ? this.journal.messageReferencePage!(projectId, task?.id, task?.agentId, before)
      : historyPage(this.messages.filter(message => message.projectId === projectId && (!task || message.taskId === task.id || message.to === task.agentId || message.to === "*")), before);
    const entries = page.entries.map(message => ({ message: this.materializeMessage(message), deliveries: [] as MessageDelivery[], deliveryCount: 0 }));
    for (const entry of entries) {
      for (const delivery of this.deliveryRecords(task?.id, entry.message.id)) {
        if (this.tasks.get(delivery.taskId)?.projectId !== projectId) continue;
        entry.deliveryCount++;
        if (entry.deliveries.length < 50) entry.deliveries.push({ ...delivery });
      }
    }
    return { ...page, entries };
  }

  resolvedContextPage(projectId: string, before?: number) {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    if (this.journal.resolvedContextPage) return this.journal.resolvedContextPage(projectId, before);
    return historyPage(this.resolvedContext.get(projectId) ?? [], before);
  }

  contextPackagesPage(projectId: string, taskId: string, before?: number) {
    const task = this.requireTask(taskId);
    if (task.projectId !== projectId) throw new Error("Görev başka projeye ait");
    if (this.journal.contextPackagesPage) return this.journal.contextPackagesPage(projectId, taskId, before);
    return historyPage(task.contextPackages ?? [], before);
  }

  snapshot(projectId: string, includeHistory = true): ProjectSnapshot {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Proje bulunamadı: ${projectId}`);
    const history = includeHistory && this.diskHistory ? materializeHistory(this.journal, projectId) : undefined;
    return {
      project: { ...project },
      tasks: [...this.tasks.values()]
        .filter((task) => task.projectId === projectId)
        .map((task) => {
          if (includeHistory) return structuredClone({ ...task, ...(history?.packages.has(task.id) ? { contextPackages: history.packages.get(task.id) } : {}) });
          const { contextPackages: _packages, ...current } = task;
          return structuredClone(current);
        }),
      context: structuredClone(Object.fromEntries(this.facts.get(projectId) ?? [])),
      contextHistory: history?.facts ?? (includeHistory ? structuredClone(Object.fromEntries(this.factHistory.get(projectId) ?? [])) : {}),
      contextConflicts: history?.conflicts ?? structuredClone([...this.contextConflicts.get(projectId)?.values() ?? []].filter(conflict => includeHistory || conflict.status === "pending")),
      messages: includeHistory ? [...this.messageRecords(projectId)].map(message => this.materializeMessage(message)) : [],
      deliveries: includeHistory ? [...this.deliveryRecords()].filter((delivery) => this.tasks.get(delivery.taskId)?.projectId === projectId).map((delivery) => ({ ...delivery })) : [],
      inboxes: [...this.tasks.values()].filter((task) => task.projectId === projectId).map((task) => {
        if (this.journal.inboxStats) return { taskId: task.id, ...this.journal.inboxStats(projectId, task.id, task.agentId) };
        const statuses = new Map([...this.deliveryRecords(task.id)].map(delivery => [delivery.messageId, delivery.status]));
        let cursor = 0, pending = 0, uncertain = 0, gap = false;
        for (const message of this.messagesFor(task)) {
          const status = statuses.get(message.id);
          if (status !== "accepted") { pending++; gap = true; }
          if (!gap) cursor++;
          if (status === "uncertain") uncertain++;
        }
        return { taskId: task.id, cursor, pending, uncertain };
      }),
    };
  }

  resolveContext(projectId: string, conflictId: string, expectedRevision: number, choice: ContextChoice, value?: string): void {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    if ([...this.controllers.keys()].some((id) => this.requireTask(id).projectId === projectId)) throw new Error("Context kararından önce çalışan görevleri durdurun veya bitmesini bekleyin");
    const conflict = this.contextConflicts.get(projectId)?.get(conflictId);
    if (!conflict || conflict.status !== "pending") throw new Error("Bekleyen context çakışması bulunamadı");
    const current = this.facts.get(projectId)?.get(conflict.key);
    if (!Number.isInteger(expectedRevision) || !current || current.revision !== expectedRevision) throw new Error("Context sürümü değişti; güncel kararı yeniden inceleyin");
    if (!["keep", "accept", "custom"].includes(choice) || (choice === "custom" && (typeof value !== "string" || !value.trim() || value.length > 16384))) throw new Error("Geçersiz context kararı");
    const at = new Date().toISOString();
    const revision = expectedRevision + (choice === "keep" ? 0 : 1);
    const events: DomainEvent[] = [];
    if (choice !== "keep") events.push({ type: "context.updated", projectId, fact: {
      key: conflict.key, value: choice === "custom" ? value! : conflict.proposal.value,
      sourceTaskId: choice === "custom" ? "@user" : conflict.proposal.sourceTaskId, updatedAt: at, revision,
    } });
    events.push({ type: "context.conflict.resolved", projectId, conflictId, choice, revision, at });
    this.emitBatch(events);
  }

  private delivery(taskId: string, messageId: string) {
    return this.diskDeliveries ? this.journal.readDelivery!(taskId, messageId) : this.deliveries.get(JSON.stringify([taskId, messageId]));
  }
  private *deliveryRecords(taskId?: string, messageId?: string): Iterable<MessageDelivery> {
    if (this.diskDeliveries) { yield* this.journal.scanDeliveries!(taskId, messageId); return; }
    for (const delivery of this.deliveries.values()) {
      if ((taskId === undefined || delivery.taskId === taskId) && (messageId === undefined || delivery.messageId === messageId)) yield delivery;
    }
  }
  private materializeMessage(reference: RetainedMessage): AgentMessage {
    if (reference.eventId === undefined) return { ...reference };
    const event = this.journal.readEvent?.(reference.eventId)?.payload;
    if (event?.type !== "message.sent" || event.message.id !== reference.id || event.message.projectId !== reference.projectId) throw new Error("Mesaj içeriği journal içinde bulunamadı");
    return { ...event.message };
  }
  private *messageRecords(projectId: string): Iterable<RetainedMessage> {
    if (this.diskMessages) { yield* this.journal.scanMessageReferences!(projectId); return; }
    for (const message of this.messages) if (message.projectId === projectId) yield message;
  }
  private *messagesFor(task: TaskRecord): Iterable<RetainedMessage> {
    for (const message of this.messageRecords(task.projectId)) {
      if (message.taskId !== task.id && (message.to === task.agentId || message.to === "*")) yield message;
    }
  }
  private recipientIds(projectId: string) {
    return [...new Set([...(this.agentSettings.get(projectId) ?? []).map((agent) => agent.id),
      ...[...this.tasks.values()].filter((task) => task.projectId === projectId).map((task) => task.agentId)])];
  }

  sendMessage(projectId: string, draft: MessageDraft, sourceTaskId?: string): string {
    if (!this.projects.has(projectId)) throw new Error("Proje bulunamadı");
    validateMessageDraft(draft, this.recipientIds(projectId));
    const source = sourceTaskId ? this.requireTask(sourceTaskId) : undefined;
    if (source && (source.projectId !== projectId || source.status !== "running")) throw new Error("Mesaj kaynağı aktif görev değil");
    const taskId = source?.id ?? "@user";
    const from = source?.agentId ?? "@user";
    const existing = this.diskMessages ? this.journal.findMessageReference!(projectId, taskId, draft.idempotencyKey)
      : this.messages.find((message) => message.projectId === projectId && message.taskId === taskId && message.idempotencyKey === draft.idempotencyKey);
    if (existing) {
      if (existing.to !== draft.to || existing.kind !== draft.kind || this.materializeMessage(existing).body !== draft.body) throw new Error("Aynı mesaj anahtarı farklı içerikle kullanılamaz");
      return existing.id;
    }
    const id = randomUUID();
    this.emit({ type: "message.sent", projectId, message: { id, projectId, taskId, from,
      to: draft.to, kind: draft.kind, body: draft.body, idempotencyKey: draft.idempotencyKey, createdAt: new Date().toISOString() } });
    return id;
  }

  retryTask(taskId: string): void {
    const task = this.requireTask(taskId);
    if (!["failed", "blocked", "needs_review", "cancelled"].includes(task.status)) {
      throw new Error(`Görev tekrar çalıştırılamaz: ${task.status}`);
    }
    this.emit({ type: "task.retried", projectId: task.projectId, taskId });
  }

  /** Explicitly stages a fresh preview after human edits, without approving it. */
  refreshReview(taskId: string): void {
    const task = this.requireTask(taskId);
    const project = this.projects.get(task.projectId);
    if (task.status !== "pending_review" || !task.review || !task.worktree || !project || !this.worktrees) {
      throw new Error("Görev inceleme beklemiyor");
    }
    const lease = this.worktrees.reopen(project.workspaceRoot, task.worktree);
    const inspection = this.worktrees.inspectTask(project.workspaceRoot, lease, task.allowedPaths);
    if (!inspection.changedPaths.length && !task.mergeConflict) throw new Error("İncelenecek değişiklik yok");
    if (inspection.violations.length) throw new Error(`İzin dışı dosyalar: ${inspection.violations.join(", ")}`);
    this.emit({ type: "task.review.requested", projectId: task.projectId, taskId,
      digest: inspection.digest, result: task.review.result, testDigest: task.testDigest });
  }

  prepareMergeResolution(taskId: string, digest: string, targetCommit: string): void {
    const task = this.requireTask(taskId);
    const project = this.projects.get(task.projectId);
    if (task.status !== "pending_review" || !task.mergeConflict || !task.worktree || !project || !this.worktrees) {
      throw new Error("Görev merge çakışması beklemiyor");
    }
    this.worktrees.validateResolution(project.workspaceRoot, task.worktree, task.allowedPaths, digest, targetCommit);
    // Persist intent first: restart can recover a merge that stopped between Git operations.
    this.emit({ type: "task.merge.prepared", projectId: task.projectId, taskId, baseCommit: targetCommit });
    this.worktrees.beginResolution(project.workspaceRoot, task.worktree, targetCommit);
    this.refreshReview(taskId);
  }

  /** A human approval must supply the exact digest from a review preview. */
  approveTask(taskId: string, approvedDigest: string): string {
    const task = this.requireTask(taskId);
    const project = this.projects.get(task.projectId);
    if (task.status !== "pending_review" || !task.review || !task.worktree || !project || !this.worktrees) {
      throw new Error(`Görev inceleme beklemiyor: ${taskId}`);
    }
    if (task.review.digest !== approvedDigest) throw new Error("Onay digest'i bekleyen inceleme ile eşleşmiyor");
    normalizeContextFacts(task.review.result.facts);
    let commit: string;
    try { commit = this.worktrees.integrate(project.workspaceRoot, task.worktree, task.allowedPaths, approvedDigest, task.id); }
    catch (error) {
      if (error instanceof MergeConflictError) this.emit({ type: "task.merge.conflicted", projectId: task.projectId, taskId, conflict: error.conflict });
      throw error;
    }
    this.emitBatch([
      { type: "task.review.approved", projectId: task.projectId, taskId, digest: approvedDigest, commit },
      ...this.resultEvents(task, task.review.result),
    ]);
    return commit;
  }

  async run(projectId: string, maxParallel = this.projects.get(projectId)?.maxParallel ?? 2, signal?: AbortSignal, includeHistory = true): Promise<ProjectSnapshot> {
    if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel >= 1 olmalı");
    if (!this.projects.has(projectId)) throw new Error(`Proje bulunamadı: ${projectId}`);
    const cancelRemaining = () => {
      for (const task of this.tasks.values()) {
        if (task.projectId === projectId && (task.status === "pending" || task.status === "running")) {
          this.cancelTask(task.id);
        }
      }
    };
    signal?.addEventListener("abort", cancelRemaining, { once: true });
    if (signal?.aborted) cancelRemaining();
    try {
      while (true) {
        if (signal?.aborted) break;
        if ([...this.contextConflicts.get(projectId)?.values() ?? []].some((conflict) => conflict.status === "pending")) break;
        const tasks = this.snapshot(projectId, false).tasks;
        for (const task of tasks.filter((item) => item.status === "pending")) {
          if (task.dependsOn.some((id) => {
            const status = this.requireTask(id).status;
            return status === "failed" || status === "blocked" || status === "needs_review" || status === "cancelled";
          })) this.emit({ type: "task.blocked", projectId, taskId: task.id });
        }
        const available = this.snapshot(projectId, false).tasks.filter((task) =>
          task.status === "pending" && task.dependsOn.every((id) => this.requireTask(id).status === "completed"),
        );
        if (available.length === 0) break;
        await Promise.all(available.slice(0, maxParallel).map((task) => this.runTask(task)));
      }
      return this.snapshot(projectId, includeHistory);
    } finally {
      signal?.removeEventListener("abort", cancelRemaining);
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    if (this.requireTask(task.id).status !== "pending") return;
    const adapter = this.adapters.get(task.agentId);
    if (!adapter) throw new Error(`Ajan kayıtlı değil: ${task.agentId}`);
    const snapshot = this.snapshot(task.projectId, false);
    let controller: AbortController | undefined;
    const executionId = randomUUID();
    let permissionEnd: "execution_ended" | "disconnect" = "execution_ended";
    let inbox: ExecutionInbox | undefined;
    try {
      const contextPackage = prepareContext(task, snapshot.tasks, snapshot.context, executionId);
      let workspaceRoot = snapshot.project.workspaceRoot;
      if (adapter.connection !== "mock") {
        if (!this.worktrees) throw new Error("Gerçek ajan için WorktreeManager gereklidir");
        if (task.allowedPaths.length === 0) throw new Error("Gerçek ajan için allowedPaths zorunludur");
        const lease = task.worktree
          ? this.worktrees.reopen(snapshot.project.workspaceRoot, task.worktree)
          : this.worktrees.prepare(snapshot.project.workspaceRoot, task.id);
        workspaceRoot = lease.path;
        if (!task.worktree) this.emit({
          type: "task.worktree.prepared", projectId: task.projectId,
          taskId: task.id, path: lease.path, branch: lease.branch, baseCommit: lease.baseCommit,
        });
      }
      controller = new AbortController();
      this.controllers.set(task.id, controller);
      this.emit({ type: "task.started", projectId: task.projectId, taskId: task.id });
      if (controller.signal.aborted) return;
      this.emit({ type: "task.context.prepared", projectId: task.projectId, taskId: task.id, package: contextPackage.metadata });
      if (controller.signal.aborted) return;
      const active = () => !!controller && !controller.signal.aborted && this.controllers.get(task.id) === controller && this.requireTask(task.id).status === "running";
      let initialBytes = 0;
      const initial: AgentMessage[] = [];
      for (const reference of this.messagesFor(task)) {
        if (task.sessionId && this.delivery(task.id, reference.id)?.status === "accepted") continue;
        if (initial.length >= 64) break;
        const message = this.materializeMessage(reference);
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (initial.length >= 64 || initialBytes + bytes > 128 * 1024) break;
        initial.push(message); initialBytes += bytes;
      }
      const initialIds = new Set(initial.map((message) => message.id));
      const receipt = (messageId: string, status: MessageDelivery["status"], mode: MessageDelivery["mode"]) =>
        this.emit({ type: "message.delivery", projectId: task.projectId, delivery: { taskId: task.id, messageId, executionId, status, mode } });
      let acknowledged = false;
      const acknowledgeInbox = () => {
        if (!active() || acknowledged) return;
        this.emitBatch(initial.map((message) => ({ type: "message.delivery" as const, projectId: task.projectId,
          delivery: { taskId: task.id, messageId: message.id, executionId, status: "accepted" as const, mode: "prompt" as const } })));
        acknowledged = true;
      };
      inbox = new ExecutionInbox({ active, signal: controller.signal,
        pending: () => {
          for (const message of this.messagesFor(task)) {
            if (!initialIds.has(message.id) && this.delivery(task.id, message.id)?.status !== "accepted") return [this.materializeMessage(message)];
          }
          return [];
        },
        record: (messageId, status) => receipt(messageId, status, "live"),
        onError: (error) => { this.notify({ kind: "output", projectId: task.projectId, taskId: task.id,
          output: { channel: "stderr", data: safeLog(`Inbox kaydı başarısız: ${String(error)}`) } }); },
      });
      this.inboxes.set(task.id, inbox);
      this.emitBatch(initial.map((message) => ({ type: "message.delivery" as const, projectId: task.projectId,
        delivery: { taskId: task.id, messageId: message.id, executionId, status: "sending" as const, mode: "prompt" as const } })));
      let sent = 0;
      const output = await adapter.execute({
        task,
        workspaceRoot,
        context: contextPackage.context,
        inbox: structuredClone(initial),
        knownAgentIds: this.recipientIds(task.projectId),
        liveMessages: adapter.liveMessages === true,
        acknowledgeInbox,
        subscribeInbox: adapter.liveMessages ? (handler) => inbox!.subscribe(handler) : undefined,
        sendMessage: (draft) => {
          if (!active()) throw new Error("Görev artık aktif değil");
          if (++sent > 64) throw new Error("Çalıştırma başına canlı mesaj sınırı aşıldı");
          return this.sendMessage(task.projectId, draft, task.id);
        },
        agentRole: this.agentSettings.get(task.projectId)?.find((agent) => agent.id === task.agentId)?.role,
        sessionId: task.sessionId,
        signal: controller.signal,
        onSession: (sessionId) => {
          if (!controller || controller.signal.aborted || this.controllers.get(task.id) !== controller
            || this.requireTask(task.id).status !== "running") return;
          if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) throw new Error("Geçersiz ajan oturumu");
          if (this.requireTask(task.id).sessionId !== sessionId) this.emit({ type: "task.session.saved", projectId: task.projectId, taskId: task.id, sessionId });
        },
        requestPermission: (proposal, signal) => {
          if (!controller || controller.signal.aborted || this.controllers.get(task.id) !== controller
            || this.requireTask(task.id).status !== "running") return Promise.resolve("deny");
          return this.permissions.request({ projectId: task.projectId, taskId: task.id, executionId }, proposal,
            signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
        },
        onOutput: (event) => this.notify({
          kind: "output", projectId: task.projectId, taskId: task.id,
          output: event.channel === "stderr"
            ? { channel: "stderr", data: safeLog(event.data) }
            : { channel: "stdout", data: { text: safeLog(typeof event.data.text === "string" ? event.data.text : JSON.stringify(event.data)) } },
        }),
      });
      if (controller.signal.aborted || this.requireTask(task.id).status === "cancelled") return;
      await inbox.close();
      if (controller.signal.aborted || this.requireTask(task.id).status === "cancelled") return;
      acknowledgeInbox();
      output.tests = normalizeTestReports(output.tests);
      output.facts = normalizeContextFacts(output.facts);
      if (output.sessionId && this.requireTask(task.id).sessionId !== output.sessionId) this.emit({
        type: "task.session.saved", projectId: task.projectId, taskId: task.id, sessionId: output.sessionId,
      });
      if (adapter.connection !== "mock") {
        const inspection = this.worktrees!.inspectTask(snapshot.project.workspaceRoot, this.requireTask(task.id).worktree!, task.allowedPaths);
        if (inspection.violations.length > 0) {
          throw new Error(`İzin verilmeyen dosya değişikliği: ${inspection.violations.join(", ")}`);
        }
        if (inspection.changedPaths.length > 0) {
          this.emit({
            type: "task.review.requested", projectId: task.projectId, taskId: task.id,
            digest: inspection.digest, result: output,
            testDigest: output.tests?.length ? inspection.digest : undefined,
          });
          return;
        }
      }
      this.emitBatch(this.resultEvents(task, output));
    } catch (error) {
      permissionEnd = "disconnect";
      if (this.requireTask(task.id).status === "cancelled") return;
      this.emit({
        type: "task.failed",
        projectId: task.projectId,
        taskId: task.id,
        error: safeLog(error instanceof Error ? error.message : String(error), "storage"),
      });
    } finally {
      await inbox?.close();
      this.inboxes.delete(task.id);
      const uncertain = [...this.deliveries.values()].filter((delivery) => delivery.executionId === executionId && delivery.status === "sending");
      if (uncertain.length) this.emitBatch(uncertain.map((delivery) => ({ type: "message.delivery", projectId: task.projectId, delivery: { ...delivery, status: "uncertain" } })));
      this.permissions.closeExecution(executionId, permissionEnd);
      controller?.abort();
      this.controllers.delete(task.id);
    }
  }

  private resultEvents(task: TaskRecord, output: AgentResult): DomainEvent[] {
      const events: DomainEvent[] = [];
      for (const fact of output.facts ?? []) {
        const proposal: Fact = { key: fact.key, value: fact.value, sourceTaskId: task.id, updatedAt: new Date().toISOString() };
        const current = this.facts.get(task.projectId)?.get(fact.key);
        if (current && current.value !== fact.value) events.push({ type: "context.conflict.created", projectId: task.projectId,
          conflict: { id: randomUUID(), key: fact.key, proposal, baseRevision: current.revision!, status: "pending" } });
        else events.push({ type: "context.updated", projectId: task.projectId, fact: proposal });
      }
      for (const message of output.messages ?? []) {
        events.push({
          type: "message.sent",
          projectId: task.projectId,
          message: {
            ...message,
            id: randomUUID(),
            projectId: task.projectId,
            taskId: task.id,
            from: task.agentId,
            createdAt: new Date().toISOString(),
          },
        });
      }
      // Gerçek CLI ajanları kendi özel native session'larını paylaşmaz.
      // Sonuç özeti her bağımlı ajanın okuyabileceği ortak hafızaya girer.
      events.push({
        type: "context.updated", projectId: task.projectId,
        fact: {
          key: `task.${task.id}.summary`, value: output.summary,
          sourceTaskId: task.id, updatedAt: new Date().toISOString(),
        },
      });
      events.push({ type: "task.completed", projectId: task.projectId, taskId: task.id, summary: output.summary,
        tests: normalizeTestReports(output.tests) });
      return events;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Görev bulunamadı: ${taskId}`);
    return task;
  }

  private emit(payload: DomainEvent): void {
    this.emitBatch([payload]);
  }

  private emitBatch(payloads: readonly DomainEvent[]): void {
    const entries = this.journal.appendBatch(payloads);
    for (const event of entries) this.apply(event.payload, event.id);
    if (entries.length) this.lastAppliedId = entries.at(-1)!.id;
    for (const event of entries) this.notify({ kind: "event", event });
    if (payloads.some((event) => event.type === "message.sent")) for (const inbox of this.inboxes.values()) inbox.wake();
  }

  private apply(event: DomainEvent, eventId: string): void {
    switch (event.type) {
      case "message.delivery":
        if (!this.diskDeliveries || event.delivery.status === "sending") this.deliveries.set(JSON.stringify([event.delivery.taskId, event.delivery.messageId]), { ...event.delivery });
        else this.deliveries.delete(JSON.stringify([event.delivery.taskId, event.delivery.messageId]));
        break;
      case "project.created":
        this.projects.set(event.project.id, { ...event.project });
        break;
      case "project.agents.configured":
        this.agentSettings.set(event.projectId, structuredClone(event.agents));
        break;
      case "project.parallelism.updated":
        this.projects.get(event.projectId)!.maxParallel = event.maxParallel;
        break;
      case "task.created":
        this.tasks.set(event.task.id, {
          ...event.task,
          dependsOn: [...event.task.dependsOn],
          allowedPaths: [...event.task.allowedPaths],
          ...(event.task.contextKeys === undefined ? {} : { contextKeys: [...event.task.contextKeys] }),
          status: "pending",
        });
        break;
      case "task.started":
        this.requireTask(event.taskId).status = "running";
        break;
      case "task.context.prepared": {
        const task = this.requireTask(event.taskId);
        this.packageCounts.set(task.id, (this.packageCounts.get(task.id) ?? 0) + 1);
        if (!this.diskHistory) (task.contextPackages ??= []).push(structuredClone(event.package));
        break;
      }
      case "task.completed": {
        const task = this.requireTask(event.taskId);
        task.status = "completed";
        task.summary = event.summary;
        task.error = undefined;
        task.review = undefined;
        task.mergeConflict = undefined;
        task.tests = structuredClone(event.tests);
        break;
      }
      case "task.failed": {
        const task = this.requireTask(event.taskId);
        task.status = "failed";
        task.error = event.error;
        break;
      }
      case "task.blocked":
        this.requireTask(event.taskId).status = "blocked";
        break;
      case "task.interrupted":
        this.requireTask(event.taskId).status = "needs_review";
        break;
      case "task.cancelled":
        this.requireTask(event.taskId).status = "cancelled";
        break;
      case "task.retried": {
        const task = this.requireTask(event.taskId);
        task.status = "pending";
        task.error = undefined;
        task.summary = undefined;
        task.review = undefined;
        task.tests = undefined;
        task.testDigest = undefined;
        break;
      }
      case "task.session.saved":
        this.requireTask(event.taskId).sessionId = event.sessionId;
        break;
      case "task.worktree.prepared":
        this.requireTask(event.taskId).worktree = { path: event.path, branch: event.branch, baseCommit: event.baseCommit };
        break;
      case "task.merge.conflicted":
        this.requireTask(event.taskId).mergeConflict = structuredClone(event.conflict);
        break;
      case "task.merge.prepared":
        this.requireTask(event.taskId).worktree!.baseCommit = event.baseCommit;
        break;
      case "task.review.requested": {
        const task = this.requireTask(event.taskId);
        task.status = "pending_review";
        task.summary = event.result.summary;
        task.review = { digest: event.digest, result: event.result };
        task.tests = structuredClone(event.result.tests);
        task.testDigest = event.testDigest;
        break;
      }
      case "task.review.approved":
        this.requireTask(event.taskId).integratedCommit = event.commit;
        break;
      case "context.updated": {
        const facts = this.facts.get(event.projectId) ?? new Map<string, Fact>();
        const fact = { ...event.fact, revision: (facts.get(event.fact.key)?.revision ?? 0) + 1 };
        if (!this.diskHistory) {
          const history = this.factHistory.get(event.projectId) ?? new Map<string, Fact[]>();
          const versions = history.get(event.fact.key) ?? [];
          versions.push(fact); history.set(fact.key, versions);
          this.factHistory.set(event.projectId, history);
        }
        facts.set(fact.key, fact);
        this.facts.set(event.projectId, facts);
        break;
      }
      case "context.conflict.created": {
        const conflicts = this.contextConflicts.get(event.projectId) ?? new Map<string, ContextConflict>();
        conflicts.set(event.conflict.id, structuredClone(event.conflict));
        this.contextConflicts.set(event.projectId, conflicts);
        break;
      }
      case "context.conflict.resolved": {
        const conflict = this.contextConflicts.get(event.projectId)!.get(event.conflictId)!;
        this.resolvedCounts.set(event.projectId, (this.resolvedCounts.get(event.projectId) ?? 0) + 1);
        if (this.diskHistory) {
          this.contextConflicts.get(event.projectId)!.delete(event.conflictId);
          break;
        }
        conflict.status = "resolved";
        conflict.resolution = { choice: event.choice, revision: event.revision, at: event.at };
        const resolved = this.resolvedContext.get(event.projectId) ?? [];
        resolved.push(conflict);
        this.resolvedContext.set(event.projectId, resolved);
        break;
      }
      case "message.sent":
        if (this.diskMessages) break;
        if (this.journal.readEvent) {
          const { body, ...metadata } = event.message;
          this.messages.push({ ...metadata, eventId });
        } else this.messages.push({ ...event.message });
        break;
    }
  }
}
