import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
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

function validSession(id: unknown): id is string { return typeof id === "string" && /^[\w-]{1,200}$/.test(id); }

/** Documented native automation, wired to the same worktree/journal flow as Codex. */
export class HeadlessCliAdapter implements AgentAdapter {
  readonly connection = "cli" as const;
  readonly interactivePermissions = false;
  constructor(readonly id: string, readonly provider: HeadlessProvider,
    private readonly options: { model?: string; executable?: string; runner?: ProcessRunner; conversationOnly?: boolean } = {}) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    if (input.sessionId && !validSession(input.sessionId)) throw new Error("Geçersiz native oturum kimliği");
    const agy = this.provider === "antigravity";
    if (!agy && !this.options.runner && !process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("Claude entegrasyonu için ANTHROPIC_API_KEY gerekli; bu bağlantı claude.ai abonelik girişini kullanmaz");
    const args = agy
      ? ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--sandbox", "--print-timeout", "8m"]
      : ["--bare", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        "--permission-mode", this.options.conversationOnly ? "plan" : "acceptEdits", "--tools", this.options.conversationOnly ? "" : "Read,Edit,Write,Glob,Grep,Bash"];
    if (agy && this.options.conversationOnly) args.push("--mode", "plan");
    if (this.options.model) args.push("--model", this.options.model);
    if (input.sessionId) args.push(agy ? "--conversation" : "--resume", input.sessionId);
    const prompt = this.options.conversationOnly ? input.task.instruction : buildPrompt(input);
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
    const { events } = await (this.options.runner ?? runJsonlProcess)({ executable: this.options.executable ?? headlessCommand(this.provider),
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
    if (typeof summary !== "string" || !summary.trim()) throw new Error(`${this.provider}: sonuç özeti boş`);
    const output = { summary: summary.trim(), sessionId: id };
    return this.options.conversationOnly ? output : normalizeTaskResult(output, input.knownAgentIds);
  }
}
