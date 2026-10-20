import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { OpenCodeServerClient } from "./opencode-server-client.js";
import { record } from "./jsonl-rpc.js";
import { safeLog } from "../core/safe-log.js";
import { sendOpenCodeCliMessage } from "./opencode-message.js";
import type { ProcessRunner } from "./cli-process.js";
import { HeadlessCliAdapter } from "./headless-cli.js";

export interface ProviderMessageInput { provider: "codex" | "opencode" | "antigravity" | "claude"; message: string; model?: string; transport?: "exec" | "server" }
export interface ProviderMessageResult { provider: string; model?: string; transport?: "exec" | "server"; response: string; elapsedMs: number; checkedAt: string }
interface MessageDependencies {
  codex?: (input: ProviderMessageInput, cwd: string, signal: AbortSignal) => Promise<string>;
  openCode?: (cwd: string, signal: AbortSignal) => Promise<Pick<OpenCodeServerClient, "request" | "close">>;
  cliRunner?: ProcessRunner;
}

export function validateProviderMessage(input: ProviderMessageInput) {
  if (!input || !["codex", "opencode", "antigravity", "claude"].includes(input.provider) || typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000
    || (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 200 || !input.model.trim()))) throw new Error("Sağlayıcı ve 1–2000 karakterlik mesaj gerekli");
  if (input.provider === "opencode" && input.model && !/^[^/\s]+\/[^\s]+$/.test(input.model)) throw new Error("OpenCode modeli provider/model biçiminde olmalı");
  if (input.transport !== undefined && (input.provider !== "opencode" || !["exec", "server"].includes(input.transport))) throw new Error("Geçersiz mesaj bağlantısı");
}

/** One independent model request, in an owned temporary directory, outside the project. */
export async function sendProviderMessage(input: ProviderMessageInput, signal?: AbortSignal, dependencies: MessageDependencies = {}): Promise<ProviderMessageResult> {
  validateProviderMessage(input);
  const cwd = mkdtempSync(join(tmpdir(), "agentmesh-message-"));
  const started = Date.now();
  const bounded = AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
  let operationError: Error | undefined;
  try {
    let response: string;
    if (input.provider === "codex") {
      if (dependencies.codex) response = await dependencies.codex(input, cwd, bounded);
      else {
        const result = await new CodexAppServerAdapter("connection-test", { model: input.model, conversationOnly: true }).execute({
          workspaceRoot: cwd, signal: bounded, context: {}, inbox: [],
          task: { id: "connection-test", projectId: "connection-test", agentId: "connection-test", title: "Bağlantı testi",
            instruction: input.message.trim(), dependsOn: [], allowedPaths: [] },
        });
        response = result.summary;
      }
    } else if (input.provider === "antigravity" || input.provider === "claude") {
      response = (await new HeadlessCliAdapter("connection-test", input.provider, { model: input.model, conversationOnly: true }).execute({
        workspaceRoot: cwd, signal: bounded, context: {}, inbox: [],
        task: { id: "connection-test", projectId: "connection-test", agentId: "connection-test", title: "Bağlantı testi", instruction: input.message.trim(), dependsOn: [], allowedPaths: [] },
      })).summary;
    } else if (input.transport !== "server") {
      response = await sendOpenCodeCliMessage(input, cwd, bounded, dependencies.cliRunner);
    } else {
      const server = dependencies.openCode ? await dependencies.openCode(cwd, bounded) : await OpenCodeServerClient.start({ cwd, signal: bounded, timeoutMs: 90000 });
      let sessionId: string | undefined;
      try {
        const session = record(await server.request("/session", "POST", {
          title: "AgentMesh connection test", permission: [{ permission: "*", pattern: "*", action: "deny" }],
        }));
        if (typeof session.id !== "string" || !/^ses[\w-]{1,200}$/.test(session.id)) throw new Error("OpenCode test oturumu oluşturulamadı");
        sessionId = session.id;
        const rules = session.permission;
        if (!Array.isArray(rules) || rules.length !== 1 || record(rules[0]).permission !== "*" || record(rules[0]).pattern !== "*" || record(rules[0]).action !== "deny") throw new Error("OpenCode test izin politikası doğrulanamadı");
        const messageID = `msg_${randomBytes(16).toString("hex")}`;
        const model = input.model?.split("/");
        const result = record(await server.request(`/session/${sessionId}/message`, "POST", {
          messageID, agent: "build", system: "Reply briefly in the user's language. This is a connection test. Do not use tools, read files, or run commands.",
          parts: [{ type: "text", text: input.message.trim() }],
          ...(model ? { model: { providerID: model[0], modelID: model.slice(1).join("/") } } : {}),
        }, 80000));
        const info = record(result.info);
        if (info.error) {
          const detail = record(record(info.error).data);
          let localService = "";
          try {
            const endpoint = new URL(String(record(detail.metadata).url));
            if (["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) localService = ` Yerel model servisi: ${endpoint.origin}`;
          } catch { /* Do not expose arbitrary provider metadata or credentials. */ }
          throw new Error(`OpenCode${typeof detail.statusCode === "number" ? ` (HTTP ${detail.statusCode})` : ""}: ${typeof detail.message === "string" ? safeLog(detail.message, "storage") : "Sağlayıcı isteği başarısız"}${localService}`);
        }
        if (info.role !== "assistant" || info.sessionID !== sessionId || info.parentID !== messageID
          || typeof record(info.time).completed !== "number" || !["stop", "end_turn", "length"].includes(String(info.finish))) throw new Error("OpenCode tamamlanmış yanıt döndürmedi");
        response = (Array.isArray(result.parts) ? result.parts.map(record) : []).filter((p) => p.type === "text" && p.sessionID === sessionId && p.messageID === info.id && !p.synthetic && !p.ignored)
          .map((p) => typeof p.text === "string" ? p.text : "").join("\n");
      } finally {
        if (sessionId) await server.request(`/session/${sessionId}`, "DELETE", undefined, 1500).catch(() => {});
        await server.close();
      }
    }
    if (!response.trim()) throw new Error("Sağlayıcı boş yanıt döndürdü");
    return { provider: input.provider, model: input.model, ...(input.provider === "opencode" ? { transport: input.transport ?? "exec" } : {}), response: safeLog(response), elapsedMs: Date.now() - started, checkedAt: new Date().toISOString() };
  } catch (error) {
    operationError = new Error(bounded.aborted ? signal?.aborted ? "Mesaj testi iptal edildi" : "Mesaj testi 90 saniyede tamamlanmadı"
      : safeLog(error instanceof Error ? error.message : String(error), "storage"));
    throw operationError;
  } finally {
    try { await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
    catch {
      if (operationError) operationError.message += " Geçici test dizini henüz temizlenemedi; native süreç dosya tutuyor olabilir.";
      else throw new Error("Yanıt alındı ancak geçici test dizini temizlenemedi; native süreç dosya tutuyor olabilir.");
    }
  }
}
