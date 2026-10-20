import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
import { buildPrompt, parseAgentEvents, runJsonlProcess, type ProcessRunner } from "./cli-process.js";
import { normalizeTaskResult } from "./task-result.js";

export function defaultOpenCodeCommand(): string {
  if (process.platform !== "win32") return "opencode";
  const installed = join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
  return existsSync(installed) ? installed : "opencode.exe";
}

export class OpenCodeCliAdapter implements AgentAdapter {
  readonly provider = "opencode";
  readonly connection = "cli" as const;
  readonly interactivePermissions = false;

  constructor(
    readonly id: string,
    private readonly options: { executable?: string; runner?: ProcessRunner; model?: string } = {},
  ) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    const args = ["run", "--format", "json", "--dir", input.workspaceRoot];
    if (this.options.model) args.push("--model", this.options.model);
    if (input.sessionId) args.push("--session", input.sessionId);
    args.push(buildPrompt(input));
    const { events } = await (this.options.runner ?? runJsonlProcess)({
      executable: this.options.executable ?? defaultOpenCodeCommand(),
      args, cwd: input.workspaceRoot,
      signal: input.signal,
      onOutput: input.onOutput,
    });
    return normalizeTaskResult(parseAgentEvents(events), input.knownAgentIds);
  }
}
