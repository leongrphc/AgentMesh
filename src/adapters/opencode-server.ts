import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
import { buildPrompt } from "./cli-process.js";
import { record, type RpcRecord } from "./jsonl-rpc.js";
import { OpenCodeServerClient, type OpenCodeServerOptions } from "./opencode-server-client.js";
import { safeLog } from "../core/safe-log.js";
import { normalizeTaskResult } from "./task-result.js";

export const openCodeSessionRules = [
  { permission: "*", pattern: "*", action: "deny" },
  ...["bash", "edit", "read"].map((permission) => ({ permission, pattern: "*", action: "ask" })),
];

/** Native PATCH appends rules; the final deny-all + ask block must win over every prior rule. */
export function hasOpenCodeSessionPolicy(value: unknown): boolean {
  return Array.isArray(value) && value.length >= openCodeSessionRules.length
    && value.slice(-openCodeSessionRules.length).every((entry, index) => {
      const rule = record(entry), expected = openCodeSessionRules[index]!;
      return Object.keys(rule).every((key) => ["permission", "pattern", "action"].includes(key))
        && rule.permission === expected.permission && rule.pattern === expected.pattern && rule.action === expected.action;
    });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(record(value)[key])]));
  return value;
}
function fingerprint(value: RpcRecord): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

type Factory = (options: OpenCodeServerOptions) => Promise<OpenCodeServerClient>;

export class OpenCodeServerAdapter implements AgentAdapter {
  readonly provider = "opencode";
  readonly connection = "cli" as const;
  readonly interactivePermissions = true;
  constructor(readonly id: string, private readonly options: { model?: string; executable?: string; serverFactory?: Factory } = {}) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    const model = this.options.model;
    if (model !== undefined && !/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error("OpenCode modeli provider/model biçiminde olmalı");
    if (input.sessionId && !/^ses[\w-]{1,200}$/.test(input.sessionId)) throw new Error("Geçersiz OpenCode oturumu");
    const server = await (this.options.serverFactory ?? OpenCodeServerClient.start)({ cwd: input.workspaceRoot, signal: input.signal, executable: this.options.executable });
    let stream: Awaited<ReturnType<OpenCodeServerClient["events"]>> | undefined;
    let sessionId: string | undefined;
    let submitted = false, complete = false;
    let fail!: (error: Error) => void;
    const eventFailure = new Promise<never>((_resolve, reject) => { fail = reject; });
    void eventFailure.catch(() => {});
    const pending = new Map<string, AbortController>();
    const seen = new Map<string, string>();
    const inScope = (path: string) => {
      if (path.includes("\0") || /^[a-z][\w+.-]*:\/\//i.test(path) || /[*?]/.test(path)) return false;
      const delta = relative(resolve(input.workspaceRoot), resolve(input.workspaceRoot, path));
      return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
    };
    const permission = async (request: RpcRecord, signal: AbortSignal) => {
      const id = request.id as string;
      const endpoint = `/permission/${encodeURIComponent(id)}/reply`;
      const current = async () => {
        const list = await server.request("/permission");
        if (!Array.isArray(list)) throw new Error("OpenCode izin listesi geçersiz");
        const active = list.map(record).find((entry) => entry.id === id);
        if (active && (active.sessionID !== sessionId || fingerprint(active) !== fingerprint(request))) throw new Error("OpenCode izin kapsamı değişti");
        return !!active;
      };
      if (!await current() || signal.aborted) return;
      const patterns = request.patterns;
      let allowed = Array.isArray(patterns) && patterns.length > 0 && patterns.length <= 100 && patterns.every((pattern) => typeof pattern === "string" && pattern.length > 0);
      const kind = request.permission === "bash" ? "command" : "file";
      if (request.permission !== "bash") {
        allowed = allowed && ["edit", "read"].includes(String(request.permission)) && (patterns as string[]).every((path) => inScope(path)
          && (request.permission !== "edit" || input.task.allowedPaths.some((pattern) => matchesGlob(relative(input.workspaceRoot, resolve(input.workspaceRoot, path)).replace(/\\/g, "/"), pattern.replace(/\\/g, "/")))));
      }
      const metadata = record(request.metadata);
      for (const path of [metadata.filepath, metadata.filePath, metadata.path, metadata.cwd]) if (typeof path === "string" && !inScope(path)) allowed = false;
      const description = JSON.stringify({ permission: request.permission, patterns, metadata }, null, 2);
      let decision: "allow_once" | "deny" = "deny";
      if (allowed && description.length <= 8192 && input.requestPermission) decision = await input.requestPermission({
        provider: "opencode", sessionId: sessionId!, nativeRequestId: id, kind, description,
      }, signal);
      if (signal.aborted || input.signal?.aborted || !await current()) return;
      const result = await server.request(endpoint, "POST", { reply: decision === "allow_once" ? "once" : "reject" });
      if (result !== true) throw new Error("OpenCode izin kararı doğrulanamadı");
    };
    try {
      let session: RpcRecord;
      if (input.sessionId) {
        session = record(await server.request(`/session/${encodeURIComponent(input.sessionId)}`));
        if (session.id !== input.sessionId || typeof session.directory !== "string" || !server.sameDirectory(session.directory)) throw new Error("OpenCode oturumu başka çalışma alanına ait");
        const states = record(await server.request("/session/status"));
        if (states[input.sessionId] && record(states[input.sessionId]).type !== "idle") throw new Error("OpenCode oturumu zaten çalışıyor");
        session = record(await server.request(`/session/${encodeURIComponent(input.sessionId)}`, "PATCH", { permission: openCodeSessionRules }));
      } else session = record(await server.request("/session", "POST", { title: input.task.title, permission: openCodeSessionRules }));
      if (typeof session.id !== "string" || !/^ses[\w-]{1,200}$/.test(session.id)
        || (input.sessionId && session.id !== input.sessionId) || typeof session.directory !== "string" || !server.sameDirectory(session.directory)
        || !hasOpenCodeSessionPolicy(session.permission)) throw new Error("OpenCode oturum kapsamı veya izin politikası doğrulanamadı");
      sessionId = session.id;
      input.onSession?.(sessionId);
      const previous = await server.request("/permission");
      if (!Array.isArray(previous) || previous.some((entry) => record(entry).sessionID === sessionId)) throw new Error("OpenCode oturumunda eski izin isteği var");
      stream = await server.events((event) => {
        const properties = record(event.properties);
        if (properties.sessionID !== sessionId) return;
        if (event.type === "permission.asked") {
          if (!submitted) { fail(new Error("OpenCode görev başlamadan izin istedi")); return; }
          if (typeof properties.id !== "string" || !/^per[\w-]{1,200}$/.test(properties.id)) { fail(new Error("Geçersiz OpenCode izin kimliği")); return; }
          const digest = fingerprint(properties);
          if (seen.has(properties.id)) {
            if (seen.get(properties.id) !== digest) fail(new Error("OpenCode izin isteği değişti"));
            return;
          }
          if (seen.size >= 128) { fail(new Error("OpenCode izin isteği limiti aşıldı")); return; }
          seen.set(properties.id, digest);
          const abort = new AbortController(); pending.set(properties.id, abort);
          void permission(properties, abort.signal).catch((error) => fail(error instanceof Error ? error : new Error("OpenCode izin hatası")))
            .finally(() => { pending.delete(properties.id as string); abort.abort(); });
          return;
        }
        if (event.type === "permission.replied" && typeof properties.requestID === "string") { pending.get(properties.requestID)?.abort(); return; }
        if (event.type === "permission.v2.asked" || event.type === "question.asked" || event.type === "question.v2.asked") {
          fail(new Error("OpenCode desteklenmeyen etkileşim istedi")); return;
        }
        if (event.type === "session.error") { fail(new Error("OpenCode oturumu hata bildirdi")); return; }
        try { input.onOutput?.({ channel: "stdout", data: { text: safeLog(JSON.stringify(event)) } }); } catch { /* Observer isolation. */ }
      });
      const messageID = `msg_${randomBytes(16).toString("hex")}`;
      const modelParts = model?.split("/");
      submitted = true;
      const result = record(await Promise.race([server.request(`/session/${encodeURIComponent(sessionId)}/message`, "POST", {
        messageID, agent: "build", parts: [{ type: "text", text: buildPrompt(input) }],
        ...(modelParts ? { model: { providerID: modelParts[0], modelID: modelParts.slice(1).join("/") } } : {}),
      }, 10 * 60 * 1000), eventFailure, stream.done]));
      const info = record(result.info);
      if (info.role !== "assistant" || info.sessionID !== sessionId || info.parentID !== messageID || typeof info.id !== "string" || info.error
        || typeof record(info.time).completed !== "number" || typeof info.finish !== "string" || ["tool-calls", "unknown", "content-filter"].includes(info.finish)) throw new Error("OpenCode tamamlanmış görev sonucu döndürmedi");
      const parts = Array.isArray(result.parts) ? result.parts.map(record) : [];
      const summary = parts.filter((part) => part.type === "text" && part.sessionID === sessionId && part.messageID === info.id && !part.synthetic && !part.ignored && typeof part.text === "string")
        .map((part) => part.text as string).join("\n").trim();
      if (!summary) throw new Error("OpenCode ajan sonucu bulunamadı");
      complete = true;
      return normalizeTaskResult({ sessionId, summary }, input.knownAgentIds);
    } finally {
      for (const abort of pending.values()) abort.abort();
      if (sessionId && submitted && !complete && !input.signal?.aborted) await server.request(`/session/${encodeURIComponent(sessionId)}/abort`, "POST", {}, 1500).catch(() => {});
      await stream?.close(); await server.close();
    }
  }
}
