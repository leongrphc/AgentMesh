import type { AgentConfig, Config } from "./config.js";
import { validate } from "./config.js";
import type { DomainEvent, StoredEvent, TaskRecord } from "./contracts.js";

export function cleanAgent(agent: AgentConfig): AgentConfig {
  return { id: agent.id, provider: agent.provider, transport: agent.transport ?? "exec",
    ...(agent.model !== undefined ? { model: agent.model } : {}), ...(agent.role !== undefined ? { role: agent.role } : {}) };
}

function signature(agents: readonly AgentConfig[]) {
  return JSON.stringify(agents.map(cleanAgent).sort((a, b) => a.id.localeCompare(b.id)));
}

/** Desktop edits are project-local overrides; the source file remains untouched. */
export function resolveAgentSettings(config: Config, events: Iterable<StoredEvent>): Config {
  let saved: Extract<DomainEvent, { type: "project.agents.configured" }> | undefined;
  for (const { payload } of events) if (payload.type === "project.agents.configured" && payload.projectId === config.projectId) saved = payload;
  if (!saved || saved.type !== "project.agents.configured") return config;
  const incoming = signature(config.agents);
  if (incoming !== signature(saved.sourceAgents) && incoming !== signature(saved.agents)) {
    throw new Error("Config ajan ayarları kayıtlı sürümden farklı. Kaynak tanımını geri yükleyin; ajan değişikliklerini Ajan merkezinden yapın.");
  }
  const resolved = { ...config, agents: saved.agents.map(cleanAgent) };
  validate(resolved);
  return resolved;
}

export function validateAgentEdit(agents: readonly AgentConfig[], draft: AgentConfig, tasks: readonly TaskRecord[]) {
  const previous = agents.find((agent) => agent.id === draft.id);
  if (previous && signature([previous]) !== signature([draft])
    && tasks.some((task) => task.agentId === draft.id && (task.status !== "pending" || !!task.sessionId || !!task.worktree))) {
    throw new Error("Bu ajanla çalışma geçmişi var. Oturumu korumak için farklı kimlikle yeni ajan ekleyin.");
  }
}
