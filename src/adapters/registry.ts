import type { Config } from "../core/config.js";
import type { AgentAdapter } from "../core/contracts.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { OpenCodeCliAdapter } from "./opencode-cli.js";
import { OpenCodeServerAdapter } from "./opencode-server.js";
import { HeadlessCliAdapter } from "./headless-cli.js";

export function configuredAdapter(agent: Config["agents"][number]): AgentAdapter {
  if (agent.provider === "antigravity" || agent.provider === "claude") return new HeadlessCliAdapter(agent.id, agent.provider, { model: agent.model });
  if (agent.provider === "codex") return agent.transport === "app-server"
    ? new CodexAppServerAdapter(agent.id, { model: agent.model })
    : new CodexCliAdapter(agent.id, { model: agent.model });
  return agent.transport === "server" ? new OpenCodeServerAdapter(agent.id, { model: agent.model }) : new OpenCodeCliAdapter(agent.id, { model: agent.model });
}
