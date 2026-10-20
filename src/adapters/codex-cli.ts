import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
import { buildPrompt, parseAgentEvents, runJsonlProcess, type ProcessRunner } from "./cli-process.js";
import { normalizeTaskResult } from "./task-result.js";

export class CodexCliAdapter implements AgentAdapter {
  readonly provider = "codex";
  readonly connection = "cli" as const;
  readonly interactivePermissions = false;

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
      executable: this.options.executable ?? (process.platform === "win32" ? "codex.exe" : "codex"),
      args,
      cwd: input.workspaceRoot,
      stdin: prompt,
      signal: input.signal,
      onOutput: input.onOutput,
    });
    return normalizeTaskResult(parseAgentEvents(events), input.knownAgentIds);
  }
}
