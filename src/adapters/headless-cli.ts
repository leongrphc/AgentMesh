import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentExecution, AgentResult, AgentUsage } from "../core/contracts.js";
import { safeLog } from "../core/safe-log.js";
import { record } from "./jsonl-rpc.js";
import { buildPrompt, runJsonlProcess, type ProcessRunner } from "./cli-process.js";
import { normalizeTaskResult } from "./task-result.js";

export type HeadlessProvider = "antigravity" | "claude";
export function headlessCommand(provider: HeadlessProvider): string {
  if (process.platform !== "win32") return provider === "antigravity" ? "agy" : "claude";
  const installed = provider === "antigravity"
    ? join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe")
    : join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(installed) ? installed : provider === "antigravity" ? "agy.exe" : "claude.exe";
}

/** Read-only commands an agent may run to look around its worktree. Everything else in Bash is refused. */
const READ_ONLY_COMMANDS = ["git status", "git diff", "git log", "git show", "ls", "dir", "pwd"];

/**
 * Claude Code permission rules for one task: reading is free, writing is limited to the task's file
 * patterns (relative to the worktree, gitignore-style like AgentMesh's own check), Bash to read-only
 * commands. "**" allows every file; the post-run scope check still applies on top.
 */
export function claudeTaskRules(allowedPaths: readonly string[]): string[] {
  const patterns = allowedPaths.map((path) => path.trim().replace(/\\/g, "/")).filter(Boolean);
  const edits = patterns.includes("**") ? ["Edit", "Write"]
    : patterns.flatMap((pattern) => [`Edit(${pattern})`, `Write(${pattern})`]);
  return ["Read", "Glob", "Grep", ...edits, ...READ_ONLY_COMMANDS.map((command) => `Bash(${command}:*)`)];
}

/** Cost and token totals from a Claude Code result event; cached input counts as input. */
function claudeUsage(result: Record<string, unknown>): AgentUsage | undefined {
  const usage = record(result.usage);
  const count = (...values: unknown[]) => values.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
  const cost = typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : undefined;
  const inputTokens = count(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
  const outputTokens = count(usage.output_tokens);
  if (cost === undefined && !inputTokens && !outputTokens) return undefined;
  return { ...(cost !== undefined ? { costUsd: cost } : {}), inputTokens, outputTokens };
}

function validSession(id: unknown): id is string { return typeof id === "string" && /^[\w-]{1,200}$/.test(id); }

/** Documented native automation, wired to the same worktree/journal flow as Codex. */
export class HeadlessCliAdapter implements AgentAdapter {
  readonly connection = "cli" as const;
  readonly interactivePermissions = false;
  constructor(readonly id: string, readonly provider: HeadlessProvider,
    private readonly options: { model?: string; executable?: string; runner?: ProcessRunner; conversationOnly?: boolean;
      /** With conversationOnly: allow reading the workspace (Read, Glob, Grep) but never writing. Used by the planner. */
      readOnlyTools?: boolean } = {}) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    if (input.sessionId && !validSession(input.sessionId)) throw new Error("Geçersiz native oturum kimliği");
    const agy = this.provider === "antigravity";
    const args = agy
      ? ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--sandbox", "--print-timeout", "8m"]
      // Claude Code authenticates itself (ANTHROPIC_API_KEY or its own login). User-level settings,
      // hooks and MCP servers are skipped so a personal setup cannot change task behaviour.
      : ["--print", "--verbose", "--setting-sources", "project", "--strict-mcp-config", "--input-format", "stream-json", "--output-format", "stream-json",
        // Tasks run in dontAsk mode: only the rules in --allowedTools apply and anything else is refused
        // up front, so file edits are limited to the task's allowedPaths before the agent writes.
        "--permission-mode", this.options.conversationOnly ? "plan" : "dontAsk",
        // Without any tool a model that wants to look at files prints imitation tool calls instead of answering.
        "--tools", this.options.conversationOnly ? this.options.readOnlyTools ? "Read,Glob,Grep" : "" : "Read,Edit,Write,Glob,Grep,Bash"];
    if (!agy && !this.options.conversationOnly) args.push("--allowedTools", claudeTaskRules(input.task.allowedPaths).join(","));
    if (agy) {
      args.push("--mode", this.options.conversationOnly ? "plan" : "accept-edits");
      // Headless runs cannot ask for command approval. Keep shell access blocked rather than
      // granting broad command prefixes merely to let the model inspect its workspace.
      args.push("--settings", JSON.stringify({ permissions: { deny: ["command(*)"] } }));
    }
    const model = input.task.model ?? this.options.model;
    if (model) args.push("--model", model);
    if (input.sessionId) args.push(agy ? "--conversation" : "--resume", input.sessionId);
    const taskPrompt = this.options.conversationOnly ? input.task.instruction : buildPrompt(input);
    const prompt = agy ? `${taskPrompt}\n\nTerminal commands are unavailable in this headless session, including dir, ls, pwd and tests. Use native file listing, search, read and edit tools instead. Do not call RunCommand. Report command-based tests as not_run.` : taskPrompt;
    const stdin = JSON.stringify(agy ? { event: "user", message: { content: prompt } }
      : { type: "user", message: { role: "user", content: prompt } }) + "\n";
    let sessionId = input.sessionId;
    let notifiedSessionId: string | undefined;
    const acceptSession = (id: unknown) => {
      if (!validSession(id) || (sessionId && sessionId !== id)) throw new Error("Native oturum kimliği eşleşmedi");
      sessionId = id;
      if (notifiedSessionId !== id) {
        notifiedSessionId = id;
        input.onSession?.(id);
      }
    };
    let nativeFailure: string | undefined;
    const onEvent = (event: Record<string, unknown>) => {
      if (agy && event.event === "result" && record(event.result).status !== "SUCCESS") {
        const result = record(event.result);
        nativeFailure = typeof result.error === "string" ? result.error : `Sonuç durumu: ${String(result.status)}`;
      } else if (!agy && event.type === "result" && (event.is_error === true || event.subtype !== "success")) {
        nativeFailure = typeof event.result === "string" && event.result.trim() ? event.result
          : Array.isArray(event.errors) ? event.errors.filter((value) => typeof value === "string").join("; ") : `Sonuç durumu: ${String(event.subtype)}`;
      }
      const id = agy ? event.event === "init" ? event.conversation_id : undefined
        : event.type === "system" && event.subtype === "init" ? event.session_id : undefined;
      if (id === undefined) return;
      acceptSession(id);
    };
    const { events, stderr } = await (this.options.runner ?? runJsonlProcess)({ executable: this.options.executable ?? headlessCommand(this.provider),
      args, cwd: input.workspaceRoot, stdin, signal: input.signal, timeoutMs: 9 * 60 * 1000, onEvent, onOutput: input.onOutput })
      .catch((error: unknown) => { if (nativeFailure && !input.signal?.aborted) throw new Error(`${this.provider}: ${safeLog(nativeFailure, "storage")}`); throw error; });
    // Injected runners and replay fixtures must obey the same identity checks.
    for (const event of events) onEvent(event);
    if (events.some((e) => e.type === "error" || e.event === "error")) throw new Error(`${this.provider}: native hata olayı`);
    const results = events.filter((event) => agy ? event.event === "result" : event.type === "result");
    if (results.length !== 1) throw new Error(`${this.provider}: tek bir tamamlanmış sonuç bekleniyor`);
    const result = agy ? record(results[0]!.result) : results[0]!;
    const id = agy ? result.conversation_id : result.session_id;
    if (!validSession(id) || (sessionId && sessionId !== id)) throw new Error("Native sonuç oturumu eşleşmedi");
    acceptSession(id);
    if (agy ? result.status !== "SUCCESS" : result.subtype !== "success" || result.is_error !== false) {
      throw new Error(`${this.provider}: ${safeLog(nativeFailure || `Görev tamamlanmadı (${String(agy ? result.status : result.subtype)})`, "storage")}`);
    }
    const summary = agy ? result.response : result.result;
    if (typeof summary !== "string" || !summary.trim()) {
      if (agy && /tool required .*permission|soft.denied|auto.denied/i.test(stderr)) {
        throw new Error(`${this.provider}: headless araç izni reddedildi: ${safeLog(stderr, "storage")}`);
      }
      throw new Error(`${this.provider}: sonuç özeti boş`);
    }
    const output = { summary: summary.trim(), sessionId: id };
    const usage = agy ? undefined : claudeUsage(result);
    const normalized = this.options.conversationOnly ? output : normalizeTaskResult(output, input.knownAgentIds);
    return usage ? { ...normalized, usage } : normalized;
  }
}
