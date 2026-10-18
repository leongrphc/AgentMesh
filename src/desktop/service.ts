import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, join, matchesGlob } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteJournal } from "../core/sqlite-journal.js";
import { Orchestrator } from "../core/orchestrator.js";
import { WorktreeManager } from "../core/worktrees.js";
import { validate, orderTasks, type Config } from "../core/config.js";
import { MockAgent } from "../adapters/mock.js";
import { CodexCliAdapter } from "../adapters/codex-cli.js";
import { OpenCodeCliAdapter } from "../adapters/opencode-cli.js";
import { safeLog } from "../core/safe-log.js";
import { listWorkspace, readWorkspaceFile, saveWorkspaceFile } from "../core/workspace-files.js";
import type { DesktopState, DesktopReview, TaskDraft } from "./contracts.js";

export class DesktopService {
  private journal?: SqliteJournal;
  private engine?: Orchestrator;
  private config?: Config;
  private demo = true;
  private running?: Promise<void>;
  private abort?: AbortController;
  private events: DesktopState["events"] = [];
  private readonly listeners = new Set<(state: DesktopState) => void>();

  constructor(private readonly dataRoot: string) {}

  subscribe(listener: (state: DesktopState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  state(): DesktopState {
    if (!this.engine || !this.config) throw new Error("Önce proje açın");
    return structuredClone({ snapshot: this.engine.snapshot(this.config.projectId), busy: !!this.running,
      demo: this.demo, agents: this.config.agents, events: this.events,
      maxParallel: this.engine.snapshot(this.config.projectId).project.maxParallel ?? this.config.maxParallel ?? 2 });
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
    return this.open(config, join(this.dataRoot, "demo.sqlite"), true);
  }

  openConfig(file: string): DesktopState {
    const config = JSON.parse(readFileSync(file, "utf8")) as Config;
    validate(config);
    config.repoPath = realpathSync(resolve(dirname(file), config.repoPath));
    const key = createHash("sha256").update(process.platform === "win32" ? config.repoPath.toLowerCase() : config.repoPath).digest("hex").slice(0, 16);
    return this.open(config, join(dirname(config.repoPath), ".agentmesh-data", key, "events.sqlite"), false);
  }

  private open(config: Config, path: string, demo: boolean): DesktopState {
    if (this.running) throw new Error("Proje değiştirmeden önce çalışan görevleri durdurun");
    this.journal?.close();
    this.engine = undefined;
    this.config = undefined;
    const journal = new SqliteJournal(path);
    try {
      const engine = new Orchestrator(journal, new WorktreeManager());
      for (const agent of config.agents) {
        engine.registerAgent(demo ? new MockAgent(agent.id, async (input) => {
          input.onOutput?.({ channel: "stdout", data: { text: `${input.task.title} başladı` } });
          await delay(1000, undefined, { signal: input.signal });
          return { summary: `${input.task.title} tamamlandı (demo).`,
            facts: [{ key: `${input.task.id}.result`, value: "Demo doğrulaması başarılı" }],
            messages: [{ to: "*", kind: "handoff", body: `${input.task.title} sonucu hazır.` }] };
        }) : agent.provider === "codex" ? new CodexCliAdapter(agent.id, { model: agent.model })
          : new OpenCodeCliAdapter(agent.id, { model: agent.model }));
      }
      let existing;
      try { existing = engine.snapshot(config.projectId); }
      catch { engine.createProject({ id: config.projectId, workspaceRoot: config.repoPath }); }
      if (existing && realpathSync(existing.project.workspaceRoot) !== realpathSync(config.repoPath)) {
        throw new Error("Proje kimliği başka depoya ait");
      }
      const tasks = engine.snapshot(config.projectId).tasks;
      for (const task of orderTasks(config.tasks)) if (!tasks.some((old) => old.id === task.id)) engine.addTask(task);
      this.journal = journal;
      this.engine = engine;
      this.config = config;
      this.demo = demo;
      this.events = journal.all().filter(({ payload }) =>
        (payload.type === "project.created" ? payload.project.id : payload.type === "task.created" ? payload.task.projectId : payload.projectId) === config.projectId)
        .slice(-200).map((event) => ({ at: event.at, text: event.payload.type,
          taskId: "taskId" in event.payload ? event.payload.taskId : event.payload.type === "task.created" ? event.payload.task.id : undefined }));
      engine.subscribe((notice) => {
        this.events.push({ at: new Date().toISOString(),
          taskId: notice.kind === "output" ? notice.taskId : "taskId" in notice.event.payload ? notice.event.payload.taskId : undefined,
          text: notice.kind === "event" ? notice.event.payload.type
            : safeLog(notice.output.channel === "stderr" ? notice.output.data
              : typeof notice.output.data.text === "string" ? notice.output.data.text : JSON.stringify(notice.output.data)),
        });
        this.events = this.events.slice(-200);
        this.publish();
      });
      this.publish();
      return this.state();
    } catch (error) { journal.close(); throw error; }
  }

  start(): void {
    if (this.running) throw new Error("Görevler zaten çalışıyor");
    if (!this.engine || !this.config) throw new Error("Önce proje açın");
    this.abort = new AbortController();
    // Defer execution so busy is visible before the first synchronous domain event.
    this.running = Promise.resolve().then(() => this.engine!.run(this.config!.projectId,
      this.state().maxParallel, this.abort!.signal)).then(() => {}, (error: unknown) => {
        this.events.push({ at: new Date().toISOString(), text: safeLog(String(error)) });
      }).finally(() => { this.running = undefined; this.abort = undefined; this.publish(); });
    this.publish();
  }

  cancel(taskId?: string): void {
    if (taskId) this.engine!.cancelTask(this.requireTask(taskId));
    else this.abort?.abort();
  }

  retry(taskId: string): void {
    if (this.running) throw new Error("Yeniden denemeden önce çalışmanın bitmesini bekleyin");
    this.engine!.retryTask(this.requireTask(taskId));
  }

  createTask(draft: TaskDraft): void {
    if (this.running) throw new Error("Görev eklemeden önce çalışmayı durdurun");
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("Geçersiz görev");
    const task = { id: draft.id, title: draft.title, instruction: draft.instruction, agentId: draft.agentId,
      dependsOn: draft.dependsOn, allowedPaths: draft.allowedPaths, projectId: this.config!.projectId };
    validate({ ...this.config!, tasks: [...this.state().snapshot.tasks, task] });
    this.engine!.addTask(task);
  }

  setParallelism(value: number): void {
    if (this.running) throw new Error("Paralelliği değiştirmeden önce çalışmayı durdurun");
    this.engine!.setParallelism(this.config!.projectId, value);
  }

  review(taskId: string, refresh = false): DesktopReview {
    this.requireTask(taskId);
    if (refresh) {
      if (this.running) throw new Error("İncelemeyi yenilemeden önce çalışmayı durdurun");
      this.engine!.refreshReview(taskId);
    }
    const task = this.state().snapshot.tasks.find((item) => item.id === taskId)!;
    if (task.status === "running" || !task.worktree) throw new Error("İncelenecek durdurulmuş çalışma alanı yok");
    const manager = new WorktreeManager();
    const lease = manager.reopen(this.config!.repoPath, task.worktree);
    const inspection = manager.inspect(lease.path, task.allowedPaths);
    return { taskId, title: task.title, inspection, expectedDigest: task.review?.digest,
      canApprove: !this.running && task.status === "pending_review" && !inspection.violations.length
        && inspection.changedPaths.length > 0 && inspection.digest === task.review?.digest };
  }

  approve(taskId: string, digest: string): void {
    if (this.running) throw new Error("Onaydan önce aktif çalışmanın bitmesini bekleyin");
    this.requireTask(taskId);
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Geçersiz inceleme digest'i");
    this.engine!.approveTask(taskId, digest);
  }

  private workspace(taskId: string) {
    this.requireTask(taskId);
    const task = this.state().snapshot.tasks.find((item) => item.id === taskId)!;
    const root = task.worktree ? new WorktreeManager().reopen(this.config!.repoPath, task.worktree).path : this.config!.repoPath;
    const writable = !!task.worktree && !this.running && !["running", "completed"].includes(task.status);
    return { root, task, writable };
  }

  files(taskId: string, path = "") {
    const { root } = this.workspace(taskId);
    return { root, entries: listWorkspace(root, path) };
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

  async close() { this.abort?.abort(); await this.running; this.journal?.close(); }
}
