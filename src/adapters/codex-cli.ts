import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
import { buildPrompt, parseAgentEvents, runJsonlProcess, type ProcessRunner } from "./cli-process.js";

export class CodexCliAdapter implements AgentAdapter {
  readonly provider = "codex";
  readonly connection = "cli" as const;

  constructor(
    readonly id: string,
    private readonly options: { executable?: string; runner?: ProcessRunner; model?: string } = {},
  ) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    const prompt = buildPrompt(input);
    const args = input.sessionId
      ? ["exec", "resume", "--json", "-c", 'sandbox_mode="workspace-write"', input.sessionId, "-"]
      : ["exec", "--json", "--sandbox", "workspace-write", "--cd", input.workspaceRoot, "-"];
    if (this.options.model) args.splice(input.sessionId ? 3 : 2, 0, "-m", this.options.model);
    const { events } = await (this.options.runner ?? runJsonlProcess)({
      executable: this.options.executable ?? "codex.exe",
      args,
      cwd: input.workspaceRoot,
      stdin: prompt,
    });
    return parseAgentEvents(events);
  }
}
