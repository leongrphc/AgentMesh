import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotClientOptions, type CopilotSession, type SessionConfig, type SessionMetadata } from "@github/copilot-sdk";
import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
import { validateTaskModel } from "../core/config.js";
import { safeLog } from "../core/safe-log.js";
import { buildPrompt } from "./cli-process.js";
import { record } from "./jsonl-rpc.js";
import { normalizeTaskResult } from "./task-result.js";

export type CopilotSessionHandle = Pick<CopilotSession, "sessionId" | "on" | "sendAndWait" | "abort" | "disconnect">;
export interface CopilotClientHandle {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  createSession(config: SessionConfig): Promise<CopilotSessionHandle>;
  resumeSession(id: string, config: SessionConfig): Promise<CopilotSessionHandle>;
  listSessions(): Promise<SessionMetadata[]>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  getStatus(): Promise<{ version: string }>;
}
export type CopilotFactory = (options: CopilotClientOptions) => CopilotClientHandle;

/** The SDK's version-matched native CLI, over stdio; no shell shim, HTTP proxy or model impersonation. */
export function copilotClientOptions(cwd: string): CopilotClientOptions {
  return { connection: RuntimeConnection.forStdio(), workingDirectory: cwd, mode: "empty",
    baseDirectory: process.env.COPILOT_HOME || join(homedir(), ".copilot"), useLoggedInUser: true, logLevel: "error" };
}
export const createCopilotClient: CopilotFactory = (options) => new CopilotClient(options);

/** Graceful detach preserves sessions; a stuck runtime is forcibly stopped rather than orphaned. */
export async function closeCopilot(client: CopilotClientHandle): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const errors = await Promise.race([client.stop(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Copilot kapanma zaman aşımı")), 2000);
    })]);
    if (errors.length) await client.forceStop();
  } catch { await client.forceStop(); }
  finally { clearTimeout(timer); }
}

const validSession = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,200}$/.test(id);
const readTools = ["view", "glob", "grep"];
const writeTools = ["edit", "create"];
const inside = (root: string, path: string) => {
  const delta = relative(root, path);
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
};

/** Resolve through the closest existing ancestor too, so new files beneath a symlink cannot escape. */
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), relative(parent, path));
  }
}

export class CopilotSdkAdapter implements AgentAdapter {
  readonly provider = "copilot";
  readonly connection = "cli" as const;
  readonly interactivePermissions = true;
  constructor(readonly id: string, private readonly options: { model?: string; clientFactory?: CopilotFactory; conversationOnly?: boolean; readOnlyTools?: boolean } = {}) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    const model = input.task.model ?? this.options.model;
    validateTaskModel(model, "copilot");
    if (input.sessionId && !validSession(input.sessionId)) throw new Error("Geçersiz Copilot oturumu");
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(9 * 60 * 1000), ...(input.signal ? [input.signal] : [])]);
    signal.throwIfAborted();
    const root = await realpath(input.workspaceRoot);
    const scope = async (value: unknown, write = false): Promise<boolean> => {
      if (typeof value !== "string" || !value || /[\u0000-\u001f*?]/.test(value) || /^[a-z][\w+.-]*:\/\//i.test(value)) return false;
      const path = resolve(root, value);
      if (!inside(root, path)) return false;
      try {
        const canonical = await canonicalPath(path);
        if (!inside(root, canonical)) return false;
        const paths = [path, canonical].map((entry) => relative(root, entry).replace(/\\/g, "/"));
        // Never let even an all-files task access Git metadata or AgentMesh's control files.
        if (paths.some((entry) => entry.split("/").some((part) => [".git", ".agentmesh"].includes(part.toLowerCase())))) return false;
        return !write || paths.every((entry) => input.task.allowedPaths.some((pattern) => matchesGlob(entry, pattern.replace(/\\/g, "/"))));
      } catch { return false; }
    };
    const client = (this.options.clientFactory ?? createCopilotClient)(copilotClientOptions(root));
    let session: CopilotSessionHandle | undefined, unsubscribe: (() => void) | undefined;
    let submitted = false, complete = false;
    const seen = new Set<string>();
    const abort = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error(input.signal?.aborted ? "Copilot görevi iptal edildi" : "Copilot görevi sona erdi veya zaman aşımına uğradı")), { once: true });
    });
    void abort.catch(() => {});
    const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, abort]);
    const tools = this.options.conversationOnly ? this.options.readOnlyTools ? readTools : [] : [...readTools, ...writeTools];
    const config: SessionConfig = {
      sessionId: input.sessionId ?? randomUUID(), model, workingDirectory: root, streaming: true,
      availableTools: tools.map((name) => `builtin:${name}`), additionalDirectories: [],
      enableConfigDiscovery: false, enableFileHooks: false, skipCustomInstructions: true,
      enableOnDemandInstructionDiscovery: false, enableHostGitOperations: false, enableSkills: false,
      enableSessionStore: false, memory: { enabled: false }, mcpServers: {}, customAgents: [],
      skillDirectories: [], agentDirectories: [], hookDirectories: [], pluginDirectories: [], instructionDirectories: [],
      infiniteSessions: { enabled: false },
      hooks: { onPreToolUse: async (request, invocation) => {
        if (!submitted || signal.aborted || !session || invocation.sessionId !== session.sessionId || request.sessionId !== session.sessionId
          || request.agentId || !tools.includes(request.toolName) || resolve(request.workingDirectory) !== root) return { permissionDecision: "deny" };
        const args = record(request.toolArgs);
        const write = writeTools.includes(request.toolName);
        const path = args.path ?? (request.toolName === "glob" || request.toolName === "grep" ? "." : undefined);
        if (!await scope(path, write)) return { permissionDecision: "deny" };
        if (request.toolName === "glob" && (typeof args.pattern !== "string" || isAbsolute(args.pattern)
          || args.pattern.replace(/\\/g, "/").split("/").includes(".."))) return { permissionDecision: "deny" };
        // Force the permission callback even if the native user's saved rules would otherwise approve.
        return { permissionDecision: "ask" };
      } },
      onPermissionRequest: async (request, invocation) => {
        const deny = { kind: "reject" as const };
        if (!submitted || signal.aborted || !session || invocation.sessionId !== session.sessionId
          || !["read", "write"].includes(request.kind) || record(request).requestSandboxBypass === true) return deny;
        if (this.options.conversationOnly && (!this.options.readOnlyTools || request.kind !== "read")) return deny;
        const data = record(request);
        const write = request.kind === "write";
        if (!await scope(write ? data.fileName : data.path, write)) return deny;
        if (typeof data.resolvedPath === "string" && !await scope(data.resolvedPath, write)) return deny;
        if (write && data.fileEdits !== undefined) {
          if (!Array.isArray(data.fileEdits) || !data.fileEdits.length) return deny;
          for (const edit of data.fileEdits) {
            const change = record(edit);
            if (!change.before && !change.after) return deny;
            for (const side of [change.before, change.after]) if (side && !await scope(record(side).path, true)) return deny;
          }
        }
        // The planner is read-only and has no interactive broker. It can read only this workspace.
        if (this.options.conversationOnly && this.options.readOnlyTools && request.kind === "read" && !request.managedApprovalRequired) return { kind: "approve-once" };
        const nativeId = typeof request.toolCallId === "string" && /^[\w-]{1,200}$/.test(request.toolCallId) ? request.toolCallId : undefined;
        const description = JSON.stringify(request, null, 2);
        const key = JSON.stringify([nativeId, request.kind, write ? data.fileName : data.path]);
        if (!nativeId || seen.has(key) || seen.size >= 128 || description.length > 8192 || !input.requestPermission) return deny;
        seen.add(key);
        try {
          const decision = await wait(input.requestPermission({ provider: "copilot", sessionId: session.sessionId,
            nativeRequestId: `${nativeId}-${seen.size}`, kind: "file", description }, signal));
          // Recheck after the human decision: the filesystem may have changed while waiting.
          if (decision !== "allow_once" || signal.aborted || !await scope(write ? data.fileName : data.path, write)) return deny;
          if (write && Array.isArray(data.fileEdits)) for (const edit of data.fileEdits) {
            for (const side of [record(edit).before, record(edit).after]) if (side && !await scope(record(side).path, true)) return deny;
          }
          return { kind: "approve-once" };
        } catch { return deny; }
      },
    };
    try {
      await wait(client.start());
      if (input.sessionId) {
        const metadata = (await wait(client.listSessions())).find((entry) => entry.sessionId === input.sessionId);
        if (!metadata || metadata.isRemote || typeof metadata.context?.workingDirectory !== "string"
          || await realpath(metadata.context.workingDirectory) !== root) throw new Error("Copilot oturumu bu çalışma alanına ait değil");
        session = await wait(client.resumeSession(input.sessionId, config));
      } else session = await wait(client.createSession(config));
      if (!validSession(session.sessionId) || session.sessionId !== config.sessionId) throw new Error("Copilot oturum kimliği eşleşmedi");
      input.onSession?.(session.sessionId);
      let nativeError: string | undefined;
      unsubscribe = session.on((event) => {
        if (event.agentId) return;
        if (event.type === "session.error") nativeError = safeLog(event.data.message, "storage");
        // Never forward auth/account metadata, permission payloads or complete file contents as logs.
        if (event.type === "assistant.message_delta" || event.type === "assistant.message") {
          const content = event.type === "assistant.message_delta" ? event.data.deltaContent : event.data.content;
          try { input.onOutput?.({ channel: "stdout", data: { type: event.type, text: safeLog(content) } }); } catch { /* Observer isolation. */ }
        }
      });
      submitted = true;
      const response = await wait(session.sendAndWait({ prompt: this.options.conversationOnly ? input.task.instruction : buildPrompt(input) }, 8 * 60 * 1000));
      if (nativeError) throw new Error(`Copilot: ${nativeError}`);
      signal.throwIfAborted();
      if (!response || response.agentId || typeof response.data.content !== "string" || !response.data.content.trim()) throw new Error("Copilot tamamlanmış yanıt döndürmedi");
      complete = true;
      const result = { sessionId: session.sessionId, summary: response.data.content.trim() };
      return this.options.conversationOnly ? result : normalizeTaskResult(result, input.knownAgentIds);
    } finally {
      lifetime.abort(); unsubscribe?.();
      if (session && submitted && !complete) {
        // Abort first, then force process cleanup if the runtime does not answer promptly.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([session.abort().catch(() => {}), new Promise<void>((done) => { timer = setTimeout(done, 1500); })]);
        clearTimeout(timer);
      }
      await closeCopilot(client);
    }
  }
}
