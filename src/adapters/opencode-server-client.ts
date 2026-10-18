import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { defaultOpenCodeCommand } from "./opencode-cli.js";
import { record } from "./jsonl-rpc.js";

export interface OpenCodeServerOptions {
  cwd: string;
  signal?: AbortSignal;
  executable?: string;
  args?: string[];
  startupTimeoutMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Validate the supported v1 surface, rather than guessing between legacy and v2 endpoints. */
export function validateOpenCodeSchema(value: unknown, version: unknown): void {
  const schema = record(value), paths = record(schema.paths), types = record(record(schema.components).schemas);
  const operation = (path: string, method: string) => record(record(paths[path])[method]);
  const body = (path: string, method: string) => record(record(record(record(operation(path, method).requestBody).content)["application/json"]).schema);
  const request = record(types.PermissionRequest);
  const required = request.required;
  const reply = record(record(body("/permission/{requestID}/reply", "post").properties).reply);
  const replies = reply.enum;
  const rule = record(record(types.PermissionRule).properties);
  const actions = record(types.PermissionAction).enum;
  if (schema.openapi !== "3.1.0" || record(schema.info).title !== "opencode" || typeof version !== "string" || !/^1\.19\.\d+(?:[-+][\w.-]+)?$/.test(version)
    || !Array.isArray(required) || !["id", "sessionID", "permission", "patterns", "metadata", "always"].every((key) => required.includes(key))
    || !Array.isArray(replies) || !["once", "reject"].every((entry) => replies.includes(entry))
    || record(rule.permission).type !== "string" || record(rule.pattern).type !== "string"
    || record(rule.action).$ref !== "#/components/schemas/PermissionAction"
    || !Array.isArray(actions) || !["ask", "deny"].every((entry) => actions.includes(entry))
    || record(record(body("/session", "post").properties).permission).$ref !== "#/components/schemas/PermissionRuleset"
    || record(record(body("/session/{sessionID}", "patch").properties).permission).$ref !== "#/components/schemas/PermissionRuleset"
    || !record(body("/session/{sessionID}/message", "post").properties).parts
    || !record(record(record(operation("/event", "get").responses)["200"]).content)["text/event-stream"]
    || !Object.keys(operation("/permission", "get")).length
    || !Object.keys(operation("/session/{sessionID}/abort", "post")).length) throw new Error("OpenCode sürümü veya izin şeması desteklenmiyor (beklenen: 1.19.x v1 API)");
}

/** Owns one authenticated loopback server. No remote URL or credential is exposed to the renderer. */
export class OpenCodeServerClient {
  private readonly child: ChildProcess;
  private readonly abort = new AbortController();
  private readonly auth: string;
  private readonly closed: Promise<void>;
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly externalAbort: () => void;
  private base = "";
  private bytes = 0;
  private stopped = false;
  version = "";

  static async start(options: OpenCodeServerOptions): Promise<OpenCodeServerClient> {
    const client = new OpenCodeServerClient(options);
    try { await client.ready; await client.verify(); return client; }
    catch (error) { await client.close(); throw error; }
  }

  private constructor(private readonly options: OpenCodeServerOptions) {
    if (options.signal?.aborted) throw new Error("OpenCode bağlantısı iptal edildi");
    const password = randomBytes(32).toString("hex");
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    this.child = spawn(options.executable ?? defaultOpenCodeCommand(), options.args ?? ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
      env: { ...process.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
    });
    this.closed = new Promise((done) => this.child.once("close", () => done()));
    this.ready = new Promise((done, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error("OpenCode sunucusu başlatılamadı")), options.startupTimeoutMs ?? 20_000);
      const read = (chunk: Buffer) => {
        if (!this.count(chunk.byteLength)) return;
        if (this.base) return;
        buffer += chunk.toString("utf8");
        const found = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)(?=\s)/);
        if (found) {
          const port = Number(found[1]);
          if (port < 1 || port > 65535) { reject(new Error("Geçersiz OpenCode portu")); return; }
          this.base = `http://127.0.0.1:${port}`; clearTimeout(timeout); done();
        }
        if (buffer.length > 65536) reject(new Error("OpenCode başlangıç çıktısı limiti aşıldı"));
      };
      this.child.stdout!.on("data", read); this.child.stderr!.on("data", read);
      this.child.once("error", () => { clearTimeout(timeout); reject(new Error("OpenCode CLI başlatılamadı")); });
      this.child.once("close", () => { clearTimeout(timeout); reject(new Error("OpenCode sunucusu kapandı")); this.stop(); });
      this.abort.signal.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("OpenCode bağlantısı kapandı veya iptal edildi")); }, { once: true });
    });
    this.externalAbort = () => this.stop();
    options.signal?.addEventListener("abort", this.externalAbort, { once: true });
    this.timer = setTimeout(() => this.stop(), options.timeoutMs ?? 10 * 60 * 1000);
    if (options.signal?.aborted) this.stop();
  }

  private count(length: number): boolean {
    this.bytes += length;
    if (this.bytes > (this.options.maxOutputBytes ?? 16 * 1024 * 1024)) { this.stop(); return false; }
    return !this.stopped;
  }

  private url(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) throw new Error("Geçersiz OpenCode endpoint");
    const url = new URL(this.base + path);
    if (url.origin !== this.base) throw new Error("OpenCode endpoint kapsamı dışında");
    url.searchParams.set("directory", this.options.cwd);
    return url.href;
  }

  private async localResponse(path: string, method: string, text: string | undefined, timeoutMs: number, authenticated: boolean): Promise<Response> {
    const url = new URL(this.url(path));
    // Native loopback HTTP avoids environment proxy routing; redirects are never followed.
    return new Promise((done, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: Number(url.port), path: url.pathname + url.search,
        method, agent: false, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
        headers: { ...(authenticated ? { Authorization: this.auth } : {}), ...(text ? { "Content-Type": "application/json" } : {}) },
      }, (incoming) => {
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          const status = incoming.statusCode ?? 500;
          const empty = [204, 205, 304].includes(status);
          done(new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
          if (empty) incoming.resume();
        } catch (error) { incoming.destroy(); reject(error); }
      });
      request.once("error", reject); request.end(text);
    });
  }

  private async response(path: string, method = "GET", body?: unknown, timeoutMs = 10000): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text && Buffer.byteLength(text) > 1024 * 1024) throw new Error("OpenCode girdi limiti aşıldı");
    const response = await this.localResponse(path, method, text, timeoutMs, true);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenCode HTTP hatası: ${response.status}`); }
    return response;
  }

  async request(path: string, method = "GET", body?: unknown, timeoutMs = 10000): Promise<unknown> {
    const response = await this.response(path, method, body, timeoutMs);
    if (response.status === 204) return undefined;
    if (!response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw new Error("OpenCode JSON yanıtı bekleniyor"); }
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (!this.count(chunk.value.byteLength) || length > 8 * 1024 * 1024) throw new Error("OpenCode yanıt boyutu limiti aşıldı");
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
  }

  private async verify(): Promise<void> {
    const anonymous = await this.localResponse("/global/health", "GET", undefined, 5000, false);
    await anonymous.body?.cancel();
    if (anonymous.status !== 401) throw new Error("OpenCode sunucusu kimlik doğrulama zorlamıyor");
    const health = record(await this.request("/global/health"));
    if (health.healthy !== true) throw new Error("OpenCode sunucusu sağlıklı değil");
    validateOpenCodeSchema(await this.request("/doc"), health.version);
    this.version = health.version as string;
    const path = record(await this.request("/path"));
    if (typeof path.directory !== "string" || !this.sameDirectory(path.directory)) throw new Error("OpenCode çalışma dizini eşleşmiyor");
  }

  sameDirectory(path: string): boolean {
    const normalize = (value: string) => process.platform === "win32" ? realpathSync(resolve(value)).toLowerCase() : realpathSync(resolve(value));
    return normalize(path) === normalize(this.options.cwd);
  }

  async events(onEvent: (event: Record<string, unknown>) => void): Promise<{ done: Promise<void>; close: () => Promise<void> }> {
    const response = await this.response("/event", "GET", undefined, this.options.timeoutMs ?? 10 * 60 * 1000);
    if (!response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel(); throw new Error("OpenCode SSE akışı bekleniyor"); }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const done = (async () => {
      let buffer = "", data: string[] = [], eventBytes = 0, count = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("OpenCode olay bağlantısı koptu");
          if (!this.count(chunk.value.byteLength)) throw new Error("OpenCode toplam çıktı limiti aşıldı");
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
            eventBytes += Buffer.byteLength(line);
            if (eventBytes > 1024 * 1024) throw new Error("OpenCode SSE olay limiti aşıldı");
            if (!line) {
              if (data.length) {
                if (++count > 20000) throw new Error("OpenCode olay sayısı limiti aşıldı");
                const value = JSON.parse(data.join("\n"));
                if (typeof record(value).type !== "string") throw new Error("Geçersiz OpenCode SSE olayı");
                onEvent(value);
              }
              data = []; eventBytes = 0;
            } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("OpenCode SSE satır limiti aşıldı");
        }
      } finally { await reader.cancel().catch(() => {}); }
    })();
    void done.catch(() => {});
    return { done, close: async () => { await reader.cancel().catch(() => {}); await done.catch(() => {}); } };
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.externalAbort);
    this.abort.abort(); this.child.kill();
  }
  async close(): Promise<void> { this.stop(); await this.closed; }
}
