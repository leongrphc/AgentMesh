import type { AgentTask } from "./contracts.js";
import { validateContextKeys } from "./context.js";

export interface Config {
  projectId: string;
  repoPath: string;
  maxParallel?: number;
  agents: AgentConfig[];
  tasks: AgentTask[];
}

export interface AgentConfig {
  id: string;
  provider: "codex" | "opencode" | "antigravity" | "claude";
  model?: string;
  role?: string;
  transport?: "exec" | "app-server" | "server";
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
    if (!agent || typeof agent.id !== "string" || !agent.id.trim() || agent.id.length > 200 || !["codex", "opencode", "antigravity", "claude"].includes(agent.provider) || registered.has(agent.id)
      || (agent.model !== undefined && (typeof agent.model !== "string" || !agent.model.trim() || agent.model.length > 200))
      || (agent.role !== undefined && (typeof agent.role !== "string" || !agent.role.trim() || agent.role.length > 2000))
      || (agent.transport !== undefined && !["exec", "app-server", "server"].includes(agent.transport))
      || (agent.transport === "app-server" && agent.provider !== "codex")
      || (agent.transport === "server" && (agent.provider !== "opencode" || (agent.model !== undefined && !/^[^/\s]+\/[^\s]+$/.test(agent.model))))) {
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
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.allowedPaths.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
      throw new Error(`Geçersiz görev: ${task?.id}`);
    }
    seen.add(task.id);
    validateContextKeys(task.contextKeys);
  }
  for (const task of config.tasks) {
    if (task.dependsOn.some((id) => !seen.has(id))) throw new Error(`Bulunmayan görev bağımlılığı: ${task.id}`);
  }
  orderTasks(config.tasks);
}

/** Preflight the entire import before any task-created event is written. */
export function reconcileTasks(config: Config, existing: readonly AgentTask[], reservedTaskIds: readonly string[] = []): AgentTask[] {
  const known = new Map(existing.map((task) => [task.id, task]));
  const agents = new Set(config.agents.map((agent) => agent.id));
  for (const task of existing) {
    if (!agents.has(task.agentId)) throw new Error(`Config uyumsuzluğu: ${task.id} görevinin ${task.agentId} ajanı eksik. Ajan eşlemesini geri ekleyin.`);
  }
  const fields = ["title", "instruction", "agentId", "dependsOn", "allowedPaths", "contextKeys"] as const;
  const value = (task: AgentTask, field: typeof fields[number]) => {
    const input = task[field];
    return Array.isArray(input) ? JSON.stringify([...new Set(input)].sort()) : input;
  };
  for (const task of config.tasks) {
    const old = known.get(task.id);
    if (!old) continue;
    const changed = fields.filter((field) => value(old, field) !== value(task, field));
    if (changed.length) throw new Error(`Config uyumsuzluğu: ${task.id} için değişen alanlar: ${changed.join(", ")}. Kayıtlı tanımı geri yükleyin veya yeni görev kimliği kullanın; mevcut görev değiştirilmedi.`);
  }
  const additions = config.tasks.filter((task) => !known.has(task.id));
  const reserved = new Set(reservedTaskIds);
  for (const task of additions) if (reserved.has(task.id)) throw new Error(`Config uyumsuzluğu: ${task.id} görev kimliği bu deponun başka projesinde kullanılıyor. Yeni kimlik kullanın.`);
  const merged = [...existing, ...additions];
  validate({ ...config, tasks: merged });
  return orderTasks(merged).filter((task) => !known.has(task.id));
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
