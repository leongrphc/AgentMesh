import { configJournalPath } from "../core/journal-location.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join, matchesGlob } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteJournal } from "../core/sqlite-journal.js";
import { Orchestrator } from "../core/orchestrator.js";
import { WorktreeManager, integrationBranch } from "../core/worktrees.js";
import { validate, reconcileTasks, type Config, type AgentConfig } from "../core/config.js";
import { cleanAgent, resolveAgentSettings, savedSourceAgents, validateAgentEdit } from "../core/agent-settings.js";
import { MockAgent } from "../adapters/mock.js";
import { configuredAdapter } from "../adapters/registry.js";
import type { PermissionDecision } from "../core/permissions.js";
import { probeCodex, probeOpenCode, probeOpenCodeServer, probeHeadlessProvider, probeCopilot, type ProviderHealth } from "../adapters/provider-health.js";
import { safeLog } from "../core/safe-log.js";
import { createWorkspaceEntry, listWorkspace, readWorkspaceFile, saveWorkspaceFile, readConflictFile, writeConflictResolution } from "../core/workspace-files.js";
import type { DesktopState, DesktopReview, TaskDraft } from "./contracts.js";
import { Terminals } from "./terminals.js";
import { sendProviderMessage, validateProviderMessage, type ProviderMessageInput, type ProviderMessageResult } from "../adapters/provider-message.js";
import type { MessageDraft } from "../core/contracts.js";
import { maintainJournal } from "../core/journal-maintenance.js";
import { listCodexProfiles } from "../adapters/codex-profiles.js";
import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { HeadlessCliAdapter } from "../adapters/headless-cli.js";
import { CopilotSdkAdapter } from "../adapters/copilot-sdk.js";
import { buildPlanPrompt, parsePlan, projectOverview } from "./planner.js";
import { describeEvent, describeOutput, eventTaskId } from "./event-text.js";
import { DEFAULT_ALLOWED_PATHS, folderConfig, hasUncommittedChanges, readRecent, rememberRecent, prepareRepository, repositoryKey } from "./folder-project.js";

export class DesktopService {
  readonly terminals = new Terminals();
  private readonly providerTerminalRoots = new Map<string, string>();

  async openProviderTerminal(model?: string) {
    if (this.running || this.healthAbort || this.messageAbort) throw new Error("Önce aktif işlemi bitirin");
    validateProviderMessage({ provider: "opencode", message: "native terminal", model });
    const root = mkdtempSync(join(tmpdir(), "agentmesh-opencode-tui-"));
    try {
      const info = await this.terminals.open("OpenCode", root, 100, 28, { model });
      this.providerTerminalRoots.set(info.id, root);
      return info;
    } catch (error) { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw error; }
  }

  async closeTerminal(id: string) {
    await this.terminals.close(id);
    const root = this.providerTerminalRoots.get(id);
    if (root) { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); this.providerTerminalRoots.delete(id); }
  }

  openTerminal(taskId: string, cols: number, rows: number) {
    const { root, writable } = this.workspace(taskId);
    if (!writable && !(this.demo && !this.running)) throw new Error("Terminal için durdurulmuş görev worktree’si gerekli");
    return this.terminals.open(taskId, root, cols, rows);
  }

  private requireClosedTerminals() {
    if (this.terminals.active) throw new Error("Önce açık terminal süreçlerini kapatın");
  }
  private journal?: SqliteJournal;
  private journalPath?: string;
  private engine?: Orchestrator;
  private config?: Config;
  private sourceAgents: AgentConfig[] = [];
  private demo = true;
  private source: DesktopState["source"] = "demo";
  private uncommitted = false;
  private integration?: string;
  private integrationPending = 0;
  /** One-off message about what opening the project changed (e.g. a repository was created). */
  private openNotice?: string;
  private codexProfiles = listCodexProfiles();
  private running?: Promise<void>;
  private abort?: AbortController;
  private events: DesktopState["events"] = [];
  private health: Record<string, ProviderHealth> = {};
  private healthAbort?: AbortController;
  private messageAbort?: AbortController;
  private messageRun?: Promise<ProviderMessageResult>;
  private testingProvider?: string;
  private readonly listeners = new Set<(state: DesktopState) => void>();

  constructor(private readonly dataRoot: string) {}

  subscribe(listener: (state: DesktopState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  currentState(): DesktopState | undefined {
    return this.engine && this.config ? this.state() : undefined;
  }

  state(): DesktopState {
    if (!this.engine || !this.config) throw new Error("Önce proje açın");
    const snapshot = this.engine.snapshot(this.config.projectId, false);
    return structuredClone({ snapshot, historyCounts: this.engine.historyCounts(this.config.projectId), busy: !!this.running,
      demo: this.demo, source: this.source, recent: readRecent(this.dataRoot), uncommittedChanges: this.uncommitted, integrationBranch: this.integration, integrationPending: this.integrationPending, openNotice: this.openNotice, codexProfiles: this.codexProfiles, planning: !!this.planAbort,
      defaultAllowedPaths: this.source === "folder" ? DEFAULT_ALLOWED_PATHS : ["src/**"], agents: this.config.agents.map((agent) => ({ ...agent,
        liveMessages: this.demo || (agent.provider === "codex" && agent.transport === "app-server"),
        interactivePermissions: this.demo || agent.provider === "copilot" || (agent.provider === "codex" && agent.transport === "app-server") || (agent.provider === "opencode" && agent.transport === "server") })),
      permissions: this.engine.pendingPermissions(this.config.projectId), events: this.events,
      health: this.health, checkingAgents: !!this.healthAbort, testingProvider: this.testingProvider,
      maxParallel: snapshot.project.maxParallel ?? this.config.maxParallel ?? 2 });
  }

  contextHistory(projectId: string, workspaceRoot: string, key: string, before?: number) {
    this.requireHistoryScope(projectId, workspaceRoot);
    return this.engine!.contextHistoryPage(projectId, key, before);
  }

  messageHistory(projectId: string, workspaceRoot: string, taskId?: string, before?: number) {
    this.requireHistoryScope(projectId, workspaceRoot);
    return this.engine!.messageHistoryPage(projectId, taskId, before);
  }

  resolvedContext(projectId: string, workspaceRoot: string, before?: number) {
    this.requireHistoryScope(projectId, workspaceRoot);
    return this.engine!.resolvedContextPage(projectId, before);
  }

  contextPackages(projectId: string, workspaceRoot: string, taskId: string, before?: number) {
    this.requireHistoryScope(projectId, workspaceRoot);
    return this.engine!.contextPackagesPage(projectId, taskId, before);
  }

  private requireHistoryScope(projectId: string, workspaceRoot: string) {
    if (!this.engine || !this.config || projectId !== this.config.projectId
      || workspaceRoot !== this.engine.snapshot(projectId, false).project.workspaceRoot) throw new Error("Proje değişti; context geçmişini yeniden açın");
  }

  openDemo(): DesktopState {
    mkdirSync(this.dataRoot, { recursive: true });
    const sample = join(this.dataRoot, "DEMO.md");
    if (!existsSync(sample)) writeFileSync(sample, "# AgentMesh demo\n\nGörevler bağımlılık sırasıyla çalışır. Bu demo dosya değiştirmez veya model çağırmaz.\n", "utf8");
    const projectId = "desktop-demo";
    const config: Config = {
      projectId, repoPath: this.dataRoot, maxParallel: 2,
      agents: ["architect", "backend", "frontend", "reviewer"].map((id) => ({ id, provider: "codex" })),
      tasks: [
        ["plan", "architect", [], "API sözleşmesini belirle"],
        ["backend", "backend", ["plan"], "Giriş servisini geliştir"],
        ["frontend", "frontend", ["plan"], "Giriş ekranını geliştir"],
        ["review", "reviewer", ["backend", "frontend"], "Sonuçları birlikte incele"],
      ].map(([id, agentId, dependsOn, title]) => ({ id: id as string, agentId: agentId as string,
        dependsOn: dependsOn as string[], title: title as string, instruction: title as string,
        projectId, allowedPaths: ["src/**"] })),
    };
    return this.open(config, join(this.dataRoot, "demo.sqlite"), true, "demo");
  }

  /** Opens any Git repository as a project without a hand-written config file. */
  openFolder(folder: string): DesktopState {
    const { root, notice } = prepareRepository(folder);
    this.open(folderConfig(root, listCodexProfiles()), join(this.dataRoot, "repos", repositoryKey(root), "events.sqlite"), false, "folder");
    rememberRecent(this.dataRoot, root);
    this.openNotice = notice;
    return this.state();
  }

  /** Reopens the most recent folder project; returns false when there is none or it can no longer be opened. */
  openLastProject(): boolean {
    const [last] = readRecent(this.dataRoot);
    if (!last) return false;
    try { this.openFolder(last.path); return true; }
    catch { return false; }
  }

  openConfig(file: string): DesktopState {
    const config = JSON.parse(readFileSync(file, "utf8")) as Config;
    validate(config);
    config.repoPath = realpathSync(resolve(dirname(file), config.repoPath));
    return this.open(config, configJournalPath(config.repoPath), false, "config");
  }

  private open(config: Config, path: string, demo: boolean, source: DesktopState["source"]): DesktopState {
    if (this.messageAbort) throw new Error("Önce mesaj testini bitirin veya iptal edin");
    if (this.running) throw new Error("Proje değiştirmeden önce çalışan görevleri durdurun");
    if (this.terminals.count) throw new Error("Proje değiştirmeden önce terminal sekmelerini kapatın");
    this.healthAbort?.abort(); this.healthAbort = undefined; this.health = {};
    const normalized = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const reused = this.journalPath === normalized && this.journal;
    const journal = reused || new SqliteJournal(path);
    try {
      // Folder projects have no source file: keep the agent list they were created with so a newer
      // default agent list never blocks reopening an existing project.
      const adopted = source === "folder" ? savedSourceAgents(config.projectId, journal.latestAgentSettings(config.projectId)) : undefined;
      if (adopted) config = { ...config, agents: adopted };
      const sourceAgents = structuredClone(config.agents);
      config = resolveAgentSettings(config, journal.latestAgentSettings(config.projectId));
      const engine = new Orchestrator(journal, new WorktreeManager());
      for (const agent of config.agents) {
        engine.registerAgent(this.makeAdapter(agent, demo));
      }
      let existing;
      try { existing = engine.snapshot(config.projectId, false); }
      catch { engine.createProject({ id: config.projectId, workspaceRoot: config.repoPath }); }
      if (existing && realpathSync(existing.project.workspaceRoot) !== realpathSync(config.repoPath)) {
        throw new Error("Proje kimliği başka depoya ait");
      }
      const tasks = engine.snapshot(config.projectId, false).tasks;
      const reserved = journal.reservedTaskIds(config.projectId);
      for (const task of reconcileTasks(config, tasks, reserved)) engine.addTask(task);
      engine.configureAgents(config.projectId, config.agents, sourceAgents);
      if (!reused) { this.maintainJournal(); this.journal?.close(); }
      this.journal = journal;
      this.journalPath = normalized;
      this.engine = engine;
      this.config = config;
      this.sourceAgents = sourceAgents;
      this.demo = demo;
      this.source = source;
      this.openNotice = undefined;
      this.uncommitted = !demo && hasUncommittedChanges(config.repoPath);
      // Informational only: a config may point at a folder that becomes a repository later.
      try { this.integration = demo ? undefined : integrationBranch(config.repoPath); }
      catch { this.integration = undefined; }
      this.codexProfiles = listCodexProfiles();
      this.refreshIntegration();
      this.events = journal.recent(config.projectId).map((event) => ({ at: event.at, text: describeEvent(event.payload),
          taskId: eventTaskId(event.payload) }));
      engine.subscribe((notice) => {
        const text = notice.kind === "event" ? describeEvent(notice.event.payload) : describeOutput(notice.output);
        if (text === undefined) return;
        this.events.push({ at: new Date().toISOString(), text: safeLog(text),
          taskId: notice.kind === "output" ? notice.taskId : eventTaskId(notice.event.payload) });
        this.events = this.events.slice(-200);
        this.publish();
      });
      this.maintainJournal();
      this.publish();
      return this.state();
    } catch (error) { if (!reused) journal.close(); throw error; }
  }

  start(): void {
    if (this.messageAbort) throw new Error("Önce mesaj testini bitirin veya iptal edin");
    this.requireClosedTerminals();
    if (this.running) throw new Error("Görevler zaten çalışıyor");
    if (!this.engine || !this.config) throw new Error("Önce proje açın");
    if (this.state().snapshot.contextConflicts.some((conflict) => conflict.status === "pending")) throw new Error("Önce Ortak context sekmesindeki çakışmaları çözün");
    this.healthAbort?.abort(); this.healthAbort = undefined;
    if (!this.demo) this.uncommitted = hasUncommittedChanges(this.config.repoPath);
    this.abort = new AbortController();
    // Defer execution so busy is visible before the first synchronous domain event.
    this.running = Promise.resolve().then(() => this.engine!.run(this.config!.projectId,
      this.state().maxParallel, this.abort!.signal, false)).then(() => {}, (error: unknown) => {
        this.events.push({ at: new Date().toISOString(), text: safeLog(String(error)) });
      }).finally(() => { this.running = undefined; this.abort = undefined; this.maintainJournal(); this.refreshIntegration(); this.publish(); });
    this.publish();
  }

  cancel(taskId?: string): void {
    if (taskId) this.engine!.cancelTask(this.requireTask(taskId));
    else this.abort?.abort();
  }

  retry(taskId: string): void {
    this.requireClosedTerminals();
    if (this.running) throw new Error("Yeniden denemeden önce çalışmanın bitmesini bekleyin");
    this.engine!.retryTask(this.requireTask(taskId));
  }

  private planAbort?: AbortController;

  /**
   * Asks one agent to break a goal into tasks. Nothing is created: the drafts go back to the user,
   * who edits and confirms them. The agent runs read-only and sees the file list and README.
   */
  async planTasks(goal: string, agentId: string): Promise<TaskDraft[]> {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    if (this.running || this.planAbort) throw new Error("Önce aktif işlemin bitmesini bekleyin");
    const text = typeof goal === "string" ? goal.trim() : "";
    if (!text || text.length > 4000) throw new Error("Hedefi 1–4000 karakter arasında yazın.");
    const snapshot = this.engine.snapshot(this.config.projectId, false);
    if (this.demo) {
      // The demo never calls a model; a fixed two-step plan shows how the dialog works.
      return parsePlan(JSON.stringify({ tasks: [
        { id: "plan-tasarim", title: `Tasarla: ${text.slice(0, 60)}`, instruction: `Şunu tasarla: ${text}`, agentId: this.config.agents[0]!.id },
        { id: "plan-uygula", title: `Uygula: ${text.slice(0, 60)}`, instruction: `Tasarıma göre uygula: ${text}`, agentId: this.config.agents[1]?.id ?? this.config.agents[0]!.id, dependsOn: ["plan-tasarim"] },
      ] }), this.config.agents, snapshot.tasks);
    }
    const agent = this.config.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error(`Bu projede böyle bir ajan yok: ${agentId}`);
    const adapter = agent.provider === "codex"
      ? new CodexAppServerAdapter(agent.id, { model: agent.model, codexHome: agent.codexHome, conversationOnly: true })
      : agent.provider === "copilot"
        ? new CopilotSdkAdapter(agent.id, { model: agent.model, conversationOnly: true, readOnlyTools: true })
      : agent.provider === "claude" || agent.provider === "antigravity"
        ? new HeadlessCliAdapter(agent.id, agent.provider, { model: agent.model, conversationOnly: true, readOnlyTools: true })
        : undefined;
    if (!adapter) throw new Error("Planlama şimdilik Claude, Codex, Copilot ve Antigravity ajanlarıyla yapılabilir.");
    const abort = new AbortController();
    this.planAbort = abort;
    this.publish();
    try {
      const prompt = buildPlanPrompt(text, this.config.agents, projectOverview(this.config.repoPath), snapshot.tasks);
      const result = await adapter.execute({ workspaceRoot: this.config.repoPath, context: {}, inbox: [],
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4 * 60 * 1000)]),
        task: { id: "plan", projectId: this.config.projectId, agentId: agent.id, title: "Plan", instruction: prompt, dependsOn: [], allowedPaths: [] } });
      return parsePlan(result.summary, this.config.agents, this.engine.snapshot(this.config.projectId, false).tasks);
    } catch (error) {
      if (abort.signal.aborted) throw new Error("Planlama iptal edildi");
      throw error;
    } finally { this.planAbort = undefined; this.publish(); }
  }

  cancelPlan(): void { this.planAbort?.abort(); }

  updateSettings(settings: import("../core/contracts.js").ProjectSettings): void {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    if (this.running) throw new Error("Ayarları değiştirmeden önce çalışmanın bitmesini bekleyin");
    this.engine.updateSettings(this.config.projectId, settings);
  }

  /**
   * With the project's auto-continue setting on, starts the agents as soon as a task is ready to run
   * (queued, every dependency completed, no open context decision), so approvals flow straight on.
   */
  private autoContinue(): void {
    if (!this.engine || !this.config || this.running || this.terminals.active || this.messageAbort) return;
    const snapshot = this.engine.snapshot(this.config.projectId, false);
    if (!snapshot.project.settings?.autoContinue) return;
    if (snapshot.contextConflicts.some((conflict) => conflict.status === "pending")) return;
    const done = new Set(snapshot.tasks.filter((task) => task.status === "completed").map((task) => task.id));
    if (!snapshot.tasks.some((task) => task.status === "pending" && task.dependsOn.every((id) => done.has(id)))) return;
    this.start();
  }

  /** Returns a reviewed task to its agent with feedback; it revises the work in the same worktree and session. */
  requestChanges(taskId: string, feedback: string): void {
    this.requireClosedTerminals();
    if (this.running) throw new Error("Değişiklik istemeden önce çalışmanın bitmesini bekleyin");
    this.engine!.requestChanges(this.requireTask(taskId), feedback);
    this.autoContinue();
  }

  /** Old and new text of one changed file, for the side-by-side diff in the review dialog. */
  reviewFile(taskId: string, path: string) {
    const task = this.state().snapshot.tasks.find((item) => item.id === this.requireTask(taskId))!;
    if (!task.worktree) throw new Error("Görevin çalışma alanı yok");
    if (typeof path !== "string" || !path) throw new Error("Geçersiz dosya yolu");
    const manager = new WorktreeManager();
    const lease = manager.reopen(this.config!.repoPath, task.worktree);
    if (!manager.inspectTask(this.config!.repoPath, lease, task.allowedPaths).changedPaths.includes(path)) throw new Error("Bu dosya görevde değişmedi");
    return { path, ...manager.fileVersions(this.config!.repoPath, lease, path) };
  }

  /** Hands a stopped task to another agent, which continues in the same worktree. */
  reassignTask(taskId: string, agentId: string): void {
    this.requireClosedTerminals();
    if (this.running) throw new Error("Görevi devretmeden önce çalışmanın bitmesini bekleyin");
    if (!this.config?.agents.some((agent) => agent.id === agentId)) throw new Error(`Bu projede böyle bir ajan yok: ${agentId}`);
    this.engine!.reassignTask(this.requireTask(taskId), agentId);
  }

  createTask(draft: TaskDraft): void {
    if (this.running) throw new Error("Görev eklemeden önce çalışmayı durdurun");
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("Geçersiz görev");
    const task = { id: draft.id, title: draft.title, instruction: draft.instruction, agentId: draft.agentId,
      dependsOn: draft.dependsOn, allowedPaths: draft.allowedPaths, contextKeys: draft.contextKeys, model: draft.model, projectId: this.config!.projectId };
    validate({ ...this.config!, tasks: [...this.state().snapshot.tasks, task] });
    this.engine!.addTask(task);
  }

  sendMessage(message: MessageDraft): string {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    return this.engine.sendMessage(this.config.projectId, message);
  }

  resolveContext(id: string, revision: number, choice: import("../core/contracts.js").ContextChoice, value?: string): void {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    if (this.running) throw new Error("Context kararından önce çalışmanın bitmesini bekleyin");
    this.engine.resolveContext(this.config.projectId, id, revision, choice, value);
  }

  saveAgent(draft: AgentConfig): void {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    if (this.running || this.healthAbort || this.messageAbort) throw new Error("Ajan ayarlarından önce aktif işlemi bitirin");
    this.requireClosedTerminals();
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("Geçersiz ajan");
    // Pick only supported fields; credentials and renderer-supplied extras never enter the journal.
    const agent = cleanAgent(draft);
    const agents = this.config.agents.filter((item) => item.id !== agent.id).concat(agent);
    const config = { ...this.config, agents, tasks: this.state().snapshot.tasks };
    validate(config);
    validateAgentEdit(this.config.agents, agent, config.tasks);
    const adapter = this.makeAdapter(agent, this.demo);
    this.engine.configureAgents(config.projectId, agents, this.sourceAgents);
    this.engine.replaceAgent(adapter);
    this.config = { ...this.config, agents };
    delete this.health[agent.id];
    this.publish();
  }

  private makeAdapter(agent: AgentConfig, demo: boolean) {
    if (!demo) return configuredAdapter(agent);
    return new MockAgent(agent.id, async (input) => {
      const stop = input.subscribeInbox?.(async (message) => {
        input.onOutput?.({ channel: "stdout", data: { text: `Demo canlı mesaj alındı: ${message.id}` } });
        return true;
      });
      try {
      input.onOutput?.({ channel: "stdout", data: { text: `${input.task.title} başladı` } });
      let permissionNote = "";
      if (input.task.id === "plan" && input.requestPermission) {
        const decision = await input.requestPermission({ provider: "mock", sessionId: "demo-session", nativeRequestId: "demo-command",
          kind: "command", description: "Demo: npm test için izin akışını dene. Gerçek komut çalıştırılmayacak." });
        permissionNote = decision === "allow_once" ? " Demo izni verildi; gerçek komut çalıştırılmadı." : " Demo izni reddedildi; gerçek komut çalıştırılmadı.";
      }
      await delay(1000, undefined, { signal: input.signal });
      return { summary: `${input.task.title} tamamlandı (demo).${permissionNote}`,
        tests: [{ name: "Gerçek proje testleri", status: "not_run", details: "Demo yalnızca orkestrasyon akışını gösterir; proje testleri çalıştırılmadı." }],
        facts: [{ key: `${input.task.id}.result`, value: "Demo doğrulaması başarılı" }],
        messages: [{ to: "*", kind: "handoff", body: `${input.task.title} sonucu hazır.` }] };
      } finally { await stop?.(); }
    });
  }

  setParallelism(value: number): void {
    if (this.running) throw new Error("Paralelliği değiştirmeden önce çalışmayı durdurun");
    this.engine!.setParallelism(this.config!.projectId, value);
  }

  decidePermission(requestId: string, executionId: string, digest: string, decision: PermissionDecision): void {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    this.engine.decidePermission(this.config.projectId, requestId, executionId, digest, decision);
  }

  async checkAgents(): Promise<void> {
    if (this.running || this.healthAbort || this.messageAbort) throw new Error("Bağlantı kontrolünden önce aktif işlemi bitirin");
    this.codexProfiles = listCodexProfiles();
    const state = this.state();
    const abort = new AbortController(); this.healthAbort = abort; this.publish();
    try {
      const probes = new Map<string, Promise<ProviderHealth>>();
      const key = (agent: DesktopState["agents"][number]) => JSON.stringify([agent.provider, agent.transport ?? "exec", agent.model ?? "", agent.codexHome ?? ""]);
      for (const agent of state.agents) if (!probes.has(key(agent))) probes.set(key(agent),
        state.demo ? Promise.resolve({ status: "configured", checkedAt: new Date().toISOString(), detail: "Yerel mock ajan; model veya CLI çağrısı yapılmaz." })
          : agent.provider === "codex" ? probeCodex(state.snapshot.project.workspaceRoot, abort.signal, undefined, undefined, agent.codexHome)
          : agent.provider === "copilot" ? probeCopilot(state.snapshot.project.workspaceRoot, abort.signal)
          : agent.provider === "antigravity" || agent.provider === "claude" ? probeHeadlessProvider(agent.provider, state.snapshot.project.workspaceRoot, abort.signal)
          : agent.transport === "server" ? probeOpenCodeServer(state.snapshot.project.workspaceRoot, agent.model, abort.signal)
          : probeOpenCode(state.snapshot.project.workspaceRoot, abort.signal));
      const results = await Promise.all(state.agents.map(async (agent) => [agent.id, await probes.get(key(agent))!] as const));
      if (this.healthAbort === abort && !abort.signal.aborted) this.health = Object.fromEntries(results);
    } finally { if (this.healthAbort === abort) { this.healthAbort = undefined; this.publish(); } }
  }

  review(taskId: string, refresh = false): DesktopReview {
    this.requireTask(taskId);
    if (refresh) {
      this.requireClosedTerminals();
      if (this.running) throw new Error("İncelemeyi yenilemeden önce çalışmayı durdurun");
      this.engine!.refreshReview(taskId);
    }
    const task = this.state().snapshot.tasks.find((item) => item.id === taskId)!;
    if (task.status === "running" || !task.worktree) throw new Error("İncelenecek durdurulmuş çalışma alanı yok");
    const manager = new WorktreeManager();
    const lease = manager.reopen(this.config!.repoPath, task.worktree);
    const inspection = manager.inspectTask(this.config!.repoPath, lease, task.allowedPaths);
    const merge = task.mergeConflict ? manager.mergeState(this.config!.repoPath, lease) : undefined;
    return { taskId, title: task.title, inspection, expectedDigest: task.review?.digest,
      tests: task.tests, testsStale: !!task.tests?.length && task.testDigest !== inspection.digest,
      merge: merge && { paths: task.mergeConflict!.paths, integrationCommit: merge.integrationCommit, active: !!merge.mergeHead, unresolved: merge.paths },
      canApprove: !this.running && !this.terminals.active && task.status === "pending_review" && !inspection.violations.length
        && !merge?.paths.length && (inspection.changedPaths.length > 0 || !!merge?.mergeHead) && inspection.digest === task.review?.digest };
  }

  prepareMergeResolution(taskId: string, digest: string, integrationCommit: string): DesktopReview {
    this.requireClosedTerminals();
    if (this.running || this.messageAbort || this.healthAbort) throw new Error("Önce aktif işlemi bitirin");
    this.engine!.prepareMergeResolution(this.requireTask(taskId), digest, integrationCommit);
    return this.review(taskId);
  }

  conflictFile(taskId: string, path: string) {
    const { root, task } = this.workspace(taskId);
    if (!task.mergeConflict || !this.review(taskId).merge?.unresolved.includes(path)) throw new Error("Çözülmemiş çakışma dosyası seçin");
    return readConflictFile(root, path);
  }

  resolveConflict(taskId: string, path: string, content: string | null, digest: string | null, keepCurrent = false): DesktopReview {
    this.requireClosedTerminals();
    if (this.running || this.messageAbort || this.healthAbort) throw new Error("Önce aktif işlemi bitirin");
    const { root, task, writable } = this.workspace(taskId);
    if (!writable || !task.mergeConflict || !task.worktree || !this.review(taskId).merge?.unresolved.includes(path)) throw new Error("Çözülmemiş çakışma dosyası seçin");
    writeConflictResolution(root, path, content, digest, task.allowedPaths, keepCurrent);
    new WorktreeManager().stageResolution(this.config!.repoPath, task.worktree, path);
    this.engine!.refreshReview(taskId);
    return this.review(taskId);
  }

  testProvider(input: ProviderMessageInput): Promise<ProviderMessageResult> {
    validateProviderMessage(input);
    if (this.running || this.healthAbort || this.messageAbort) throw new Error("Mesaj testinden önce aktif işlemi bitirin");
    const abort = new AbortController(); this.messageAbort = abort; this.testingProvider = input.provider;
    this.messageRun = Promise.resolve().then(() => sendProviderMessage(input, abort.signal)).finally(() => {
      this.messageAbort = undefined; this.messageRun = undefined; this.testingProvider = undefined; this.publish();
    });
    this.publish();
    return this.messageRun;
  }

  cancelProviderTest() { this.messageAbort?.abort(); }

  approve(taskId: string, digest: string): void {
    this.requireClosedTerminals();
    if (this.running) throw new Error("Onaydan önce aktif çalışmanın bitmesini bekleyin");
    this.requireTask(taskId);
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Geçersiz inceleme digest'i");
    this.engine!.approveTask(taskId, digest);
    this.refreshIntegration();
    this.publish();
    this.autoContinue();
  }

  /** Approved commits waiting on the integration branch; kept as a cached count for the UI. */
  private refreshIntegration() {
    if (this.demo || !this.config) { this.integrationPending = 0; return; }
    try { this.integrationPending = new WorktreeManager().pendingIntegration(this.config.repoPath); }
    catch { this.integrationPending = 0; }
  }

  /** Merges approved work into the user's checked-out branch, so it appears in the selected folder. */
  applyIntegration(): { branch: string; commits: number; fastForward: boolean; cleaned: number } {
    if (!this.config || !this.engine) throw new Error("Önce proje açın");
    if (this.demo) throw new Error("Demo projesinde uygulanacak gerçek değişiklik yok");
    if (this.running) throw new Error("Önce çalışan görevlerin bitmesini bekleyin");
    this.requireClosedTerminals();
    try {
      const applied = new WorktreeManager().applyIntegration(this.config.repoPath);
      // Work that is now in the user's branch no longer needs its worktree.
      return { ...applied, cleaned: this.engine.releaseFinishedWorktrees(this.config.projectId).length };
    } finally {
      this.uncommitted = hasUncommittedChanges(this.config.repoPath);
      this.refreshIntegration();
      this.publish();
    }
  }

  private workspace(taskId: string) {
    this.requireTask(taskId);
    const task = this.state().snapshot.tasks.find((item) => item.id === taskId)!;
    const root = task.worktree ? new WorktreeManager().reopen(this.config!.repoPath, task.worktree).path : this.config!.repoPath;
    const writable = !!task.worktree && !this.running && !["running", "completed"].includes(task.status);
    return { root, task, writable };
  }

  files(taskId: string, path = "") {
    const { root, writable } = this.workspace(taskId);
    return { root, writable, entries: listWorkspace(root, path) };
  }

  createEntry(taskId: string, path: string, directory: boolean) {
    const { root, writable, task } = this.workspace(taskId);
    if (!writable) throw new Error("Yalnızca durdurulmuş görev worktree'si düzenlenebilir");
    return createWorkspaceEntry(root, path, directory, task.allowedPaths);
  }

  readFile(taskId: string, path: string) {
    const { root, writable, task } = this.workspace(taskId);
    const file = readWorkspaceFile(root, path);
    return { ...file, writable: writable && task.allowedPaths.some((pattern) => {
      // Save rechecks the same policy before touching disk.
      return matchesGlob(path.replace(/\\/g, "/"), pattern.replace(/\\/g, "/"));
    }) };
  }

  saveFile(taskId: string, path: string, content: string, digest: string) {
    const { root, writable, task } = this.workspace(taskId);
    if (!writable) throw new Error("Yalnızca durdurulmuş görev worktree'si düzenlenebilir");
    return saveWorkspaceFile(root, path, content, digest, task.allowedPaths);
  }

  private requireTask(taskId: string): string {
    if (typeof taskId !== "string" || !this.state().snapshot.tasks.some((task) => task.id === taskId)) {
      throw new Error("Geçersiz görev");
    }
    return taskId;
  }

  private publish() {
    for (const listener of this.listeners) {
      try { listener(this.state()); } catch { /* UI cannot interrupt execution. */ }
    }
  }

  private maintainJournal() {
    if (!this.journal || !this.engine || !this.config?.journalMaintenance || !this.journalPath || this.running) return;
    try {
      const result = maintainJournal(this.journal, this.engine, this.journalPath, this.config.journalMaintenance);
      if (result.status === "compacted") this.events.push({ at: new Date().toISOString(),
        text: result.maintenanceError ? `Journal arşivlendi; fiziksel küçültme tamamlanamadı: ${safeLog(result.maintenanceError)}` : `Journal bakımı: ${result.activeEvents} aktif olay doğrulanan arşive taşındı.` });
      if (result.status !== "disabled" && result.retention) {
        if (result.retention.removed) this.events.push({ at: new Date().toISOString(), text: `Arşiv bakımı: ${result.retention.removed} eski yönetilen kopya kaldırıldı; olay geçmişi korundu.` });
        for (const error of result.retention.errors) this.events.push({ at: new Date().toISOString(), text: `Arşiv kopyası temizlenemedi: ${safeLog(error)}` });
      }
    } catch (error) {
      this.events.push({ at: new Date().toISOString(), text: `Journal bakımı tamamlanamadı: ${safeLog(String(error))}` });
    }
    this.events = this.events.slice(-200);
  }

  async close() {
    this.messageAbort?.abort(); await this.messageRun?.catch(() => {});
    await this.terminals.closeAll();
    for (const root of this.providerTerminalRoots.values()) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.providerTerminalRoots.clear();
    this.healthAbort?.abort(); this.healthAbort = undefined; this.abort?.abort(); await this.running;
    this.maintainJournal();
    this.journal?.close(); this.journal = undefined; this.journalPath = undefined;
  }
}
