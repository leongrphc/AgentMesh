import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { safeLog } from "../core/safe-log.js";
import type { AgentOutput } from "../core/contracts.js";

export type RpcRecord = Record<string, unknown>;
export function record(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}
export interface RpcOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxOutputBytes?: number;
  onNotification: (method: string, params: RpcRecord) => void;
  onRequest: (method: string, params: RpcRecord, id: string | number) => Promise<unknown>;
  onExit: (error: Error) => void;
  onOutput?: (output: AgentOutput) => void;
}

/** Persistent bidirectional JSONL. A failed/aborted transport rejects every outstanding call. */
export class JsonlRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: RpcRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly serverRequests = new Set<string>();
  private nextId = 1;
  private stopped = false;
  private readonly closed: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;

  constructor(private readonly options: RpcOptions) {
    if (options.signal?.aborted) throw new Error("RPC işlemi iptal edildi");
    this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()));
    let buffer = "", stderr = "", bytes = 0;
    const count = (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) this.fail(new Error("RPC toplam çıktı limiti aşıldı"));
      return !this.stopped;
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (text: string) => {
      if (!count(text)) return;
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > (options.maxLineBytes ?? 1024 * 1024)) return this.fail(new Error("RPC satır limiti aşıldı"));
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { return this.fail(new Error("Geçersiz RPC JSONL mesajı")); }
        if (this.stopped) return;
      }
      if (Buffer.byteLength(buffer) > (options.maxLineBytes ?? 1024 * 1024)) this.fail(new Error("RPC satır limiti aşıldı"));
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => { if (count(text)) stderr += text; });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", () => {
      if (stderr) this.report({ channel: "stderr", data: safeLog(stderr) });
      this.fail(new Error("RPC bağlantısı kapandı"));
    });
    this.abort = () => this.fail(new Error("RPC işlemi iptal edildi"));
    options.signal?.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(() => this.fail(new Error("RPC çalışma süresi doldu")), options.timeoutMs ?? 10 * 60 * 1000);
    if (options.signal?.aborted) this.abort();
  }

  request(method: string, params: RpcRecord): Promise<RpcRecord> {
    if (this.stopped) return Promise.reject(new Error("RPC bağlantısı kapalı"));
    if (this.pending.size >= 64) return Promise.reject(new Error("RPC bekleyen istek limiti aşıldı"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`RPC yanıt süresi doldu: ${method}`)), this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: RpcRecord = {}): void { this.send({ method, params }); }

  private send(message: RpcRecord): void {
    if (this.stopped) return;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > 1024 * 1024) return this.fail(new Error("RPC girdi limiti aşıldı"));
    this.child.stdin.write(line);
  }

  private receive(value: unknown): void {
    const message = record(value);
    if (!Object.keys(message).length) throw new Error("RPC mesajı nesne olmalı");
    if (typeof message.method === "string") {
      const params = record(message.params);
      if (message.id !== undefined) {
        if (typeof message.id !== "string" && typeof message.id !== "number") throw new Error("Geçersiz RPC kimliği");
        const id = message.id;
        const key = JSON.stringify(id);
        if (this.serverRequests.has(key) || this.serverRequests.size >= 128) throw new Error("Tekrarlı veya çok fazla RPC isteği");
        this.serverRequests.add(key);
        // Request handlers may wait for a human while stdout keeps flowing.
        void Promise.resolve().then(() => this.stopped ? Promise.reject(new Error("closed")) : this.options.onRequest(message.method as string, params, id)).then(
          (result) => this.send({ id, result }),
          () => this.send({ id, error: { code: -32601, message: "İstek desteklenmiyor veya reddedildi" } }),
        );
      } else {
        this.report({ channel: "stdout", data: { text: safeLog(JSON.stringify(message)) } });
        this.options.onNotification(message.method, params);
      }
      return;
    }
    if (typeof message.id !== "number") throw new Error("Geçersiz RPC yanıtı");
    const entry = this.pending.get(message.id);
    if (!entry) throw new Error("Eşleşmeyen RPC yanıtı");
    this.pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`RPC hatası: ${safeLog(JSON.stringify(message.error), "storage")}`));
    else if ("result" in message) entry.resolve(record(message.result));
    else entry.reject(new Error("RPC yanıtında sonuç bulunamadı"));
  }

  private report(output: AgentOutput) { try { this.options.onOutput?.(output); } catch { /* Observer isolation. */ } }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.abort);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.child.kill();
    this.options.onExit(error);
  }

  async close(): Promise<void> { this.fail(new Error("RPC bağlantısı kapatıldı")); await this.closed; }
}
