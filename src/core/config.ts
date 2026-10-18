import type { AgentTask } from "./contracts.js";

export interface Config {
  projectId: string;
  repoPath: string;
  maxParallel?: number;
  agents: Array<{ id: string; provider: "codex" | "opencode"; model?: string; transport?: "exec" | "app-server" }>;
  tasks: AgentTask[];
}

export function validate(config: Config): void {
  if (!config || typeof config.projectId !== "string" || !config.projectId.trim() || typeof config.repoPath !== "string" || !config.repoPath.trim() || !Array.isArray(config.agents) || !Array.isArray(config.tasks)) {
    throw new Error("Config: projectId, repoPath, agents[] ve tasks[] zorunlu");
  }
  if (config.maxParallel !== undefined && (!Number.isInteger(config.maxParallel) || config.maxParallel < 1 || config.maxParallel > 8)) {
    throw new Error("maxParallel 1-8 aralığında olmalı");
  }
  const registered = new Set<string>();
  for (const agent of config.agents) {
    if (!agent || typeof agent.id !== "string" || !agent.id.trim() || !["codex", "opencode"].includes(agent.provider) || registered.has(agent.id)
      || (agent.model !== undefined && typeof agent.model !== "string")
      || (agent.transport !== undefined && !["exec", "app-server"].includes(agent.transport))
      || (agent.transport === "app-server" && agent.provider !== "codex")) {
      throw new Error(`Geçersiz veya tekrarlı ajan: ${agent?.id}`);
    }
    registered.add(agent.id);
  }
  const seen = new Set<string>();
  for (const task of config.tasks) {
    if (!task || typeof task.id !== "string" || !task.id.trim() || seen.has(task.id) || task.projectId !== config.projectId ||
      !registered.has(task.agentId) || typeof task.title !== "string" || !task.title.trim() || typeof task.instruction !== "string" || !task.instruction.trim() ||
      !Array.isArray(task.dependsOn) || !Array.isArray(task.allowedPaths) || !task.allowedPaths.length ||
      task.dependsOn.some((id) => typeof id !== "string") ||
      task.allowedPaths.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
      throw new Error(`Geçersiz görev: ${task?.id}`);
    }
    seen.add(task.id);
  }
  for (const task of config.tasks) {
    if (task.dependsOn.some((id) => !seen.has(id))) throw new Error(`Bulunmayan görev bağımlılığı: ${task.id}`);
  }
  orderTasks(config.tasks);
}

export function orderTasks(tasks: AgentTask[]): AgentTask[] {
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
