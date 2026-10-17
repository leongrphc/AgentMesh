import { randomUUID } from "node:crypto";
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
} from "./contracts.js";
import type { EventStore } from "./journal.js";
import type { WorktreeManager } from "./worktrees.js";

export interface ProjectSnapshot {
  project: Project;
  tasks: TaskRecord[];
  context: Record<string, Fact>;
  messages: AgentMessage[];
}

/** Live notifications are ephemeral; domain events are additionally kept in the journal. */
export type OrchestratorNotice =
  | { kind: "event"; event: StoredEvent }
  | { kind: "output"; projectId: string; taskId: string; output: AgentOutput };

export class Orchestrator {
  private readonly projects = new Map<string, Project>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly facts = new Map<string, Map<string, Fact>>();
  private readonly messages: AgentMessage[] = [];
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly subscribers = new Set<(notice: OrchestratorNotice) => void>();

  constructor(private readonly journal: EventStore, private readonly worktrees?: WorktreeManager) {
    for (const event of journal.all()) this.apply(event.payload);
    // Çökme sonrası aynı komutları otomatik tekrar çalıştırmak tehlikeli olabilir.
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.emit({ type: "task.interrupted", projectId: task.projectId, taskId: task.id });
      }
    }
  }

  registerAgent(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Ajan zaten kayıtlı: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
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

  addTask(task: AgentTask): void {
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
    this.emit({ type: "task.created", task });
  }

  snapshot(projectId: string): ProjectSnapshot {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Proje bulunamadı: ${projectId}`);
    return {
      project: { ...project },
      tasks: [...this.tasks.values()]
        .filter((task) => task.projectId === projectId)
        .map((task) => ({ ...task, dependsOn: [...task.dependsOn], allowedPaths: [...task.allowedPaths] })),
      context: Object.fromEntries(this.facts.get(projectId) ?? []),
      messages: this.messages.filter((message) => message.projectId === projectId).map((x) => ({ ...x })),
    };
  }

  retryTask(taskId: string): void {
    const task = this.requireTask(taskId);
    if (!["failed", "blocked", "needs_review", "cancelled"].includes(task.status)) {
      throw new Error(`Görev tekrar çalıştırılamaz: ${task.status}`);
    }
    this.emit({ type: "task.retried", projectId: task.projectId, taskId });
  }

  /** A human approval must supply the exact digest from a review preview. */
  approveTask(taskId: string, approvedDigest: string): string {
    const task = this.requireTask(taskId);
    const project = this.projects.get(task.projectId);
    if (task.status !== "pending_review" || !task.review || !task.worktree || !project || !this.worktrees) {
      throw new Error(`Görev inceleme beklemiyor: ${taskId}`);
    }
    if (task.review.digest !== approvedDigest) throw new Error("Onay digest'i bekleyen inceleme ile eşleşmiyor");
    const commit = this.worktrees.integrate(project.workspaceRoot, task.worktree, task.allowedPaths, approvedDigest, task.id);
    this.emitBatch([
      { type: "task.review.approved", projectId: task.projectId, taskId, digest: approvedDigest, commit },
      ...this.resultEvents(task, task.review.result),
    ]);
    return commit;
  }

  async run(projectId: string, maxParallel = 2, signal?: AbortSignal): Promise<ProjectSnapshot> {
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
        const tasks = this.snapshot(projectId).tasks;
        for (const task of tasks.filter((item) => item.status === "pending")) {
          if (task.dependsOn.some((id) => {
            const status = this.requireTask(id).status;
            return status === "failed" || status === "blocked" || status === "needs_review" || status === "cancelled";
          })) this.emit({ type: "task.blocked", projectId, taskId: task.id });
        }
        const available = this.snapshot(projectId).tasks.filter((task) =>
          task.status === "pending" && task.dependsOn.every((id) => this.requireTask(id).status === "completed"),
        );
        if (available.length === 0) break;
        await Promise.all(available.slice(0, maxParallel).map((task) => this.runTask(task)));
      }
      return this.snapshot(projectId);
    } finally {
      signal?.removeEventListener("abort", cancelRemaining);
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    if (this.requireTask(task.id).status !== "pending") return;
    const adapter = this.adapters.get(task.agentId);
    if (!adapter) throw new Error(`Ajan kayıtlı değil: ${task.agentId}`);
    const snapshot = this.snapshot(task.projectId);
    let controller: AbortController | undefined;
    try {
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
          taskId: task.id, path: lease.path, branch: lease.branch,
        });
      }
      controller = new AbortController();
      this.controllers.set(task.id, controller);
      this.emit({ type: "task.started", projectId: task.projectId, taskId: task.id });
      if (controller.signal.aborted) return;
      const output = await adapter.execute({
        task,
        workspaceRoot,
        context: snapshot.context,
        inbox: snapshot.messages.filter((message) => message.to === task.agentId || message.to === "*"),
        sessionId: task.sessionId,
        signal: controller.signal,
        onOutput: (event) => this.notify({ kind: "output", projectId: task.projectId, taskId: task.id, output: event }),
      });
      if (controller.signal.aborted || this.requireTask(task.id).status === "cancelled") return;
      if (output.sessionId) this.emit({
        type: "task.session.saved", projectId: task.projectId, taskId: task.id, sessionId: output.sessionId,
      });
      if (adapter.connection !== "mock") {
        const inspection = this.worktrees!.inspect(workspaceRoot, task.allowedPaths);
        if (inspection.violations.length > 0) {
          throw new Error(`İzin verilmeyen dosya değişikliği: ${inspection.violations.join(", ")}`);
        }
        if (inspection.changedPaths.length > 0) {
          this.emit({
            type: "task.review.requested", projectId: task.projectId, taskId: task.id,
            digest: inspection.digest, result: output,
          });
          return;
        }
      }
      this.emitBatch(this.resultEvents(task, output));
    } catch (error) {
      if (this.requireTask(task.id).status === "cancelled") return;
      this.emit({
        type: "task.failed",
        projectId: task.projectId,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.controllers.delete(task.id);
    }
  }

  private resultEvents(task: TaskRecord, output: AgentResult): DomainEvent[] {
      const events: DomainEvent[] = [];
      for (const fact of output.facts ?? []) {
        events.push({
          type: "context.updated",
          projectId: task.projectId,
          fact: {
            key: fact.key,
            value: fact.value,
            sourceTaskId: task.id,
            updatedAt: new Date().toISOString(),
          },
        });
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
      events.push({ type: "task.completed", projectId: task.projectId, taskId: task.id, summary: output.summary });
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
    for (const event of payloads) this.apply(event);
    for (const event of entries) this.notify({ kind: "event", event });
  }

  private apply(event: DomainEvent): void {
    switch (event.type) {
      case "project.created":
        this.projects.set(event.project.id, { ...event.project });
        break;
      case "task.created":
        this.tasks.set(event.task.id, {
          ...event.task,
          dependsOn: [...event.task.dependsOn],
          allowedPaths: [...event.task.allowedPaths],
          status: "pending",
        });
        break;
      case "task.started":
        this.requireTask(event.taskId).status = "running";
        break;
      case "task.completed": {
        const task = this.requireTask(event.taskId);
        task.status = "completed";
        task.summary = event.summary;
        task.error = undefined;
        task.review = undefined;
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
        break;
      }
      case "task.session.saved":
        this.requireTask(event.taskId).sessionId = event.sessionId;
        break;
      case "task.worktree.prepared":
        this.requireTask(event.taskId).worktree = { path: event.path, branch: event.branch };
        break;
      case "task.review.requested": {
        const task = this.requireTask(event.taskId);
        task.status = "pending_review";
        task.summary = event.result.summary;
        task.review = { digest: event.digest, result: event.result };
        break;
      }
      case "task.review.approved":
        this.requireTask(event.taskId).integratedCommit = event.commit;
        break;
      case "context.updated": {
        const facts = this.facts.get(event.projectId) ?? new Map<string, Fact>();
        facts.set(event.fact.key, event.fact);
        this.facts.set(event.projectId, facts);
        break;
      }
      case "message.sent":
        this.messages.push(event.message);
        break;
    }
  }
}
