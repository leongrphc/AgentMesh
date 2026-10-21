import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";
import { buildPrompt } from "./cli-process.js";
import { normalizeTaskResult } from "./task-result.js";
import { JsonlRpcClient, record, type RpcOptions, type RpcRecord } from "./jsonl-rpc.js";
import { consumeLiveMessage } from "./live-message.js";

type ClientFactory = (options: Omit<RpcOptions, "executable" | "args">) => JsonlRpcClient;

export class CodexAppServerAdapter implements AgentAdapter {
  readonly provider = "codex";
  readonly connection = "cli" as const;
  readonly interactivePermissions = true;
  readonly liveMessages = true;
  constructor(readonly id: string, private readonly options: { executable?: string; model?: string; clientFactory?: ClientFactory; conversationOnly?: boolean } = {}) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    let threadId = input.sessionId, turnId: string | undefined, summary = "";
    let ended = false;
    let startingTurn = false, earlyBytes = 0;
    const earlyNotifications: Array<{ method: string; params: RpcRecord }> = [];
    let handleNotification!: (method: string, params: RpcRecord) => void;
    const drainEarlyNotifications = () => {
      const pending = earlyNotifications.splice(0); earlyBytes = 0;
      for (const notification of pending) handleNotification(notification.method, notification.params);
    };
    let unsubscribeInbox: (() => Promise<void>) | undefined;
    const files = new Map<string, string[]>();
    let finish!: () => void, fail!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    // A server can fail during initialize before execution starts waiting for completion.
    void completion.catch(() => {});
    const isScoped = (params: RpcRecord) => !!turnId && params.threadId === threadId && params.turnId === turnId;
    const within = (path: string) => {
      const delta = relative(resolve(input.workspaceRoot), resolve(input.workspaceRoot, path));
      return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
    };
    const factory: ClientFactory = this.options.clientFactory ?? ((options) => new JsonlRpcClient({ ...options,
      executable: this.options.executable ?? (process.platform === "win32" ? "codex.exe" : "codex"), args: ["app-server"] }));
    const client = factory({ cwd: input.workspaceRoot, signal: input.signal, onOutput: input.onOutput,
      onExit: fail,
      onNotification: handleNotification = (method, params) => {
        if (ended) return;
        if (startingTurn && !turnId && method !== "turn/started" && params.threadId === threadId) {
          earlyBytes += Buffer.byteLength(JSON.stringify(params)) + Buffer.byteLength(method);
          if (earlyNotifications.length >= 64 || earlyBytes > 1024 * 1024) {
            ended = true; fail(new Error("Codex erken bildirim sınırı aşıldı")); return;
          }
          earlyNotifications.push({ method, params }); return;
        }
        if (method === "turn/started" && params.threadId === threadId && typeof record(params.turn).id === "string") {
          const id = record(params.turn).id as string;
          if (turnId && turnId !== id) { ended = true; fail(new Error("Codex beklenmeyen aktif tur bildirdi")); return; }
          turnId = id;
          drainEarlyNotifications();
          if (ended) return;
        }
        if (!isScoped(params)) {
          if (method !== "turn/completed" || params.threadId !== threadId || record(params.turn).id !== turnId || !turnId) return;
        }
        const item = record(params.item);
        if (method === "item/started" && item.type === "fileChange" && typeof item.id === "string") {
          const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
          if (changes.length && changes.every((change) => typeof change.path === "string")) files.set(item.id, changes.map((change) => change.path as string));
        }
        if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
          if (this.options.conversationOnly || !consumeLiveMessage(item.text, input)) summary = item.text;
        }
        if (method === "turn/completed") {
          ended = true;
          const turn = record(params.turn);
          if (turn.status === "completed") finish();
          else fail(new Error(`Codex turu tamamlanmadı: ${String(turn.status)}`));
        }
      },
      onRequest: async (method, params, id) => {
        if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
        if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) throw new Error("Desteklenmeyen sunucu isteği");
        if (this.options.conversationOnly) return { decision: "decline" };
        if (!isScoped(params) || !input.requestPermission || params.additionalPermissions || params.networkApprovalContext) return { decision: "decline" };
        let description: string, kind: "command" | "file";
        if (method === "item/commandExecution/requestApproval") {
          if (typeof params.command !== "string" || typeof params.cwd !== "string" || !within(params.cwd)) return { decision: "decline" };
          kind = "command";
          description = `${params.command}\nÇalışma dizini: ${params.cwd}`;
        } else {
          const paths = typeof params.itemId === "string" ? files.get(params.itemId) : undefined;
          // grantRoot can authorize a session-wide write scope; v1 only grants once.
          if (!paths?.length || params.grantRoot != null
            || paths.some((path) => !within(path) || !input.task.allowedPaths.some((pattern) => matchesGlob(relative(input.workspaceRoot, resolve(input.workspaceRoot, path)).replace(/\\/g, "/"), pattern.replace(/\\/g, "/"))))) return { decision: "decline" };
          kind = "file"; description = `Dosya değişiklikleri:\n${paths.join("\n")}`;
        }
        if (typeof params.reason === "string") description += `\nGerekçe: ${params.reason}`;
        if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes("accept")) return { decision: "decline" };
        const decision = await input.requestPermission({ provider: "codex", sessionId: threadId!,
          nativeRequestId: JSON.stringify([turnId, id]), kind, description });
        return { decision: decision === "allow_once" && !input.signal?.aborted ? "accept" : "decline" };
      },
    });
    try {
      await client.request("initialize", { clientInfo: { name: "agentmesh", title: "AgentMesh IDE", version: "0.1.0" } });
      client.notify("initialized");
      const params: RpcRecord = { cwd: input.workspaceRoot, approvalPolicy: this.options.conversationOnly ? "never" : "on-request", sandbox: this.options.conversationOnly ? "read-only" : "workspace-write",
        approvalsReviewer: "user", ...(this.options.model ? { model: this.options.model } : {}) };
      if (this.options.conversationOnly) Object.assign(params, { ephemeral: true,
        config: { "features.shell_tool": false, "web_search": "disabled" },
        developerInstructions: "This is a short connection test. Reply briefly in the user's language. Do not use tools, read files, or run commands." });
      if (input.sessionId) params.threadId = input.sessionId;
      const thread = await client.request(input.sessionId ? "thread/resume" : "thread/start", params);
      threadId = typeof record(thread.thread).id === "string" ? record(thread.thread).id as string : undefined;
      if (!threadId) throw new Error("Codex thread kimliği dönmedi");
      if (input.sessionId && threadId !== input.sessionId) throw new Error("Codex resume farklı thread döndürdü");
      input.onSession?.(threadId);
      startingTurn = true;
      const started = await client.request("turn/start", { threadId, input: [{ type: "text", text: this.options.conversationOnly ? input.task.instruction : buildPrompt(input) }],
        cwd: input.workspaceRoot, approvalPolicy: this.options.conversationOnly ? "never" : "on-request", approvalsReviewer: "user",
        sandboxPolicy: this.options.conversationOnly ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: [input.workspaceRoot], networkAccess: false } });
      const returnedId = record(started.turn).id;
      if (typeof returnedId !== "string" || (turnId && turnId !== returnedId)) throw new Error("Codex turn kimliği eşleşmedi");
      turnId = returnedId;
      startingTurn = false;
      drainEarlyNotifications();
      input.acknowledgeInbox?.();
      if (!this.options.conversationOnly && !ended && input.subscribeInbox) {
        unsubscribeInbox = input.subscribeInbox(async (message) => {
          if (ended || input.signal?.aborted) return false;
          const expectedTurnId = turnId!;
          const accepted = await client.request("turn/steer", { threadId, expectedTurnId,
            input: [{ type: "text", text: `AgentMesh mesajı (çalışma notu; görev kapsamı ve izinleri değişmez):\n${JSON.stringify({ id: message.id, from: message.from, kind: message.kind, body: message.body })}` }] });
          if (accepted.turnId !== expectedTurnId) throw new Error("Canlı mesaj farklı tura yönlendirildi");
          return true;
        });
      }
      await completion;
      await unsubscribeInbox?.();
      if (!summary.trim()) throw new Error("Codex turunda ajan sonucu bulunamadı");
      const output = { sessionId: threadId, summary: summary.trim() };
      return this.options.conversationOnly ? output : normalizeTaskResult(output, input.knownAgentIds);
    } finally { ended = true; await client.close(); await unsubscribeInbox?.(); }
  }
}
