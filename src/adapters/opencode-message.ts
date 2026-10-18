import { defaultOpenCodeCommand } from "./opencode-cli.js";
import { runJsonlProcess, parseAgentEvents, type ProcessRunner } from "./cli-process.js";
import type { ProviderMessageInput } from "./provider-message.js";

/** Uses the documented native run command, not a direct inference/API request. */
export async function sendOpenCodeCliMessage(input: ProviderMessageInput, cwd: string, signal: AbortSignal,
  runner: ProcessRunner = runJsonlProcess): Promise<string> {
  let inherited: Record<string, unknown> = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      inherited = parsed;
    } catch { throw new Error("OPENCODE_CONFIG_CONTENT geçerli bir JSON nesnesi olmalı"); }
  }
  const agent = "agentmesh-message-test";
  const config = { ...inherited, permission: { "*": "deny" }, agent: {
    ...(inherited.agent && typeof inherited.agent === "object" && !Array.isArray(inherited.agent) ? inherited.agent : {}),
    [agent]: { mode: "primary", prompt: "Reply briefly in the user's language. This is a connection test. Do not use tools, read files, or run commands.", permission: { "*": "deny" } },
  } };
  const args = ["run", "--format", "json", "--dir", cwd, "--agent", agent];
  if (input.model) args.push("--model", input.model);
  args.push("--", input.message.trim());
  const { events } = await runner({ executable: defaultOpenCodeCommand(), args, cwd, signal,
    timeoutMs: 85000, maxOutputBytes: 2 * 1024 * 1024,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  });
  // CLI may emit an error event while exiting with status 0; parsing must reject it.
  const result = parseAgentEvents(events);
  if (!events.some((event) => event.type === "step_finish" && (event.part as { reason?: string } | undefined)?.reason === "stop"))
    throw new Error("OpenCode CLI tamamlanmış mesaj sonucu döndürmedi");
  return result.summary;
}
