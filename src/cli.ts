import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SqliteJournal } from "./core/sqlite-journal.js";
import { Orchestrator } from "./core/orchestrator.js";
import { WorktreeManager } from "./core/worktrees.js";
import { CodexCliAdapter } from "./adapters/codex-cli.js";
import { OpenCodeCliAdapter } from "./adapters/opencode-cli.js";
import type { AgentTask } from "./core/contracts.js";

interface Config {
  projectId: string;
  repoPath: string;
  maxParallel?: number;
  agents: Array<{ id: string; provider: "codex" | "opencode"; model?: string }>;
  tasks: AgentTask[];
}

function validate(config: Config): void {
  if (!config || !config.projectId || !config.repoPath || !Array.isArray(config.agents) || !Array.isArray(config.tasks)) {
    throw new Error("Config: projectId, repoPath, agents[] ve tasks[] zorunlu");
  }
  if (config.maxParallel !== undefined && (!Number.isInteger(config.maxParallel) || config.maxParallel < 1 || config.maxParallel > 8)) {
    throw new Error("maxParallel 1-8 aralığında olmalı");
  }
  const registered = new Set<string>();
  for (const agent of config.agents) {
    if (!agent.id || !["codex", "opencode"].includes(agent.provider) || registered.has(agent.id)) {
      throw new Error(`Geçersiz veya tekrarlı ajan: ${agent.id}`);
    }
    registered.add(agent.id);
  }
  const seen = new Set<string>();
  for (const task of config.tasks) {
    if (!task.id || seen.has(task.id) || task.projectId !== config.projectId ||
      !registered.has(task.agentId) || !task.title || !task.instruction ||
      !Array.isArray(task.dependsOn) || !Array.isArray(task.allowedPaths) || !task.allowedPaths.length ||
      task.allowedPaths.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
      throw new Error(`Geçersiz görev: ${task.id}`);
    }
    seen.add(task.id);
  }
  for (const task of config.tasks) {
    if (task.dependsOn.some((id) => !seen.has(id))) throw new Error(`Bulunmayan görev bağımlılığı: ${task.id}`);
  }
  orderTasks(config.tasks);
}

function orderTasks(tasks: AgentTask[]): AgentTask[] {
  const known = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const visiting = new Set<string>();
  const result: AgentTask[] = [];
  function visit(task: AgentTask): void {
    if (completed.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error(`Döngüsel görev bağımlılığı: ${task.id}`);
    visiting.add(task.id);
    for (const parentId of task.dependsOn) {
      const parent = known.get(parentId);
      if (!parent) throw new Error(`Görev bulunamadı: ${parentId}`);
      visit(parent);
    }
    visiting.delete(task.id);
    completed.add(task.id);
    result.push(task);
  }
  for (const task of tasks) visit(task);
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configArg = args[configIndex + 1];
  if (configIndex < 0 || !configArg) {
    throw new Error("Kullanım: npm run live -- --config .\\agentmesh.config.json [--execute]");
  }
  const configFile = resolve(configArg);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Config;
  validate(config);
  const repoPath = isAbsolute(config.repoPath)
    ? realpathSync(config.repoPath) : realpathSync(resolve(dirname(configFile), config.repoPath));
  if (!args.includes("--execute")) {
    console.log(JSON.stringify({
      dryRun: true, repoPath, projectId: config.projectId,
      agents: config.agents, tasks: config.tasks.map(({ id, agentId, dependsOn, allowedPaths }) => ({ id, agentId, dependsOn, allowedPaths })),
      instruction: "Gerçek model çağrısı ve worktree açmak için --execute verin.",
    }, null, 2));
    return;
  }
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Gerçek çalıştırma için ilk commit'i yapılmış Git deposu gerekli: ${repoPath}`);
  }
  const repoKey = createHash("sha256").update(repoPath.toLowerCase()).digest("hex").slice(0, 16);
  const dbPath = join(dirname(repoPath), ".agentmesh-data", repoKey, "events.sqlite");
  const journal = new SqliteJournal(dbPath);
  try {
    const manager = new WorktreeManager();
    const engine = new Orchestrator(journal, manager);
    for (const agent of config.agents) {
      engine.registerAgent(agent.provider === "codex"
        ? new CodexCliAdapter(agent.id, { model: agent.model })
        : new OpenCodeCliAdapter(agent.id, { model: agent.model }));
    }
    let existing;
    try { existing = engine.snapshot(config.projectId); }
    catch { engine.createProject({ id: config.projectId, workspaceRoot: repoPath }); }
    existing = engine.snapshot(config.projectId);
    if (realpathSync(existing.project.workspaceRoot).toLowerCase() !== repoPath.toLowerCase()) {
      throw new Error("Proje kimliği başka depo ile eşleşiyor");
    }
    for (const task of orderTasks(config.tasks)) {
      const old = existing.tasks.find((item) => item.id === task.id);
      if (old) continue;
      engine.addTask(task);
    }
    const snapshot = await engine.run(config.projectId, config.maxParallel ?? 2);
    const reports = snapshot.tasks.map((task) => {
      const changes = task.worktree && existsSync(task.worktree.path)
        ? manager.inspect(task.worktree.path, task.allowedPaths)
        : undefined;
      return {
        id: task.id, agentId: task.agentId, status: task.status,
        summary: task.summary, error: task.error, sessionId: task.sessionId,
        worktree: task.worktree,
        changedPaths: changes?.changedPaths,
        violations: changes?.violations,
      };
    });
    console.log(JSON.stringify({ dbPath, reports }, null, 2));
    if (reports.some((task) => task.status !== "completed")) process.exitCode = 1;
  } finally { journal.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
