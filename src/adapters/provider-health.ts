import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { JsonlRpcClient, record, type RpcOptions } from "./jsonl-rpc.js";
import { defaultOpenCodeCommand } from "./opencode-cli.js";
import { safeLog } from "../core/safe-log.js";
import { OpenCodeServerClient, type OpenCodeServerOptions } from "./opencode-server-client.js";
import { headlessCommand, type HeadlessProvider } from "./headless-cli.js";
import { codexEnv, defaultCodexHome } from "./codex-profiles.js";
import { closeCopilot, copilotClientOptions, createCopilotClient, type CopilotFactory } from "./copilot-sdk.js";

export interface ProviderHealth {
  status: "configured" | "needs_login" | "needs_setup" | "installed" | "unavailable";
  detail: string;
  checkedAt: string;
}

export async function probeHeadlessProvider(provider: HeadlessProvider, cwd: string, signal?: AbortSignal): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await promisify(execFile)(headlessCommand(provider), ["--version"], { cwd, signal, timeout: 7000, maxBuffer: 8192, windowsHide: true, shell: false });
    const version = result.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    if (!version) throw new Error("No version");
    if (provider === "claude") {
      if (process.env.ANTHROPIC_API_KEY?.trim()) return { status: "configured", checkedAt, detail: `Claude Code ${version} · ANTHROPIC_API_KEY ile bağlanır.` };
      // Only the logged-in flag and method are read; email, organisation and tokens never leave this function.
      const auth = await promisify(execFile)(headlessCommand(provider), ["auth", "status"], { cwd, signal, timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true, shell: false })
        .then((out) => record(JSON.parse(out.stdout)), () => ({} as Record<string, unknown>));
      if (auth.loggedIn === true) return { status: "configured", checkedAt,
        detail: `Claude Code ${version} · ${auth.authMethod === "claude.ai" ? "claude.ai hesabıyla" : "kayıtlı girişle"} bağlı. Kullanım hesabınızın limitlerinden düşer.` };
      return { status: "needs_login", checkedAt, detail: `Claude Code ${version} bulundu ama giriş yapılmamış. Terminalde: claude auth login` };
    }
    return { status: "installed", checkedAt, detail: `${provider === "antigravity" ? "Antigravity" : "Claude Code"} ${version} bulundu; giriş, model erişimi ve kota sınanmadı. Native headless politikaları geçerlidir; etkileşimli izin köprüsü yok.` };
  } catch { return { status: "unavailable", checkedAt, detail: signal?.aborted ? "Kontrol iptal edildi." : `${provider} CLI açılamadı; kurulumu ve PATH ayarını kontrol edin.` }; }
}
/** Read-only runtime/auth metadata only: no session, login, refresh request or model call. */
export async function probeCopilot(cwd: string, signal?: AbortSignal, factory: CopilotFactory = createCopilotClient): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  const client = factory(copilotClientOptions(cwd));
  const bounded = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Copilot kontrolü iptal edildi"));
    bounded.addEventListener("abort", onAbort, { once: true });
    if (bounded.aborted) onAbort();
  });
  void aborted.catch(() => {});
  try {
    await Promise.race([client.start(), aborted]);
    const [status, auth] = await Promise.race([Promise.all([client.getStatus(), client.getAuthStatus()]), aborted]);
    const version = status.version.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "SDK";
    return { status: auth.isAuthenticated ? "configured" : "needs_login", checkedAt,
      detail: auth.isAuthenticated ? `GitHub Copilot ${version} · native hesap kaydı bulundu; model erişimi ve kota sınanmadı.`
        : `GitHub Copilot ${version} · giriş gerekli. Terminalde copilot açıp /login kullanın.` };
  } catch { return { status: "unavailable", checkedAt, detail: signal?.aborted ? "Kontrol iptal edildi." : "Copilot native runtime veya protokolü açılamadı; SDK kurulumunu kontrol edin." }; }
  finally { if (onAbort) bounded.removeEventListener("abort", onAbort); await closeCopilot(client); }
}
type ClientFactory = (options: Omit<RpcOptions, "executable" | "args">) => JsonlRpcClient;

/**
 * Codex can be pointed at a local bridge or proxy through openai_base_url. When that endpoint is a
 * loopback address that refuses connections, every task fails with "os error 10061" after several
 * reconnect attempts; detect it up front instead. Returns a user-facing problem or undefined.
 */
export async function codexEndpointProblem(codexHome?: string): Promise<string | undefined> {
  const home = codexHome ?? defaultCodexHome();
  let text: string;
  try { text = await readFile(join(home, "config.toml"), "utf8"); } catch { return undefined; }
  const topLevel = text.split(/^\s*\[/m)[0] ?? "";
  const configured = topLevel.match(/^\s*openai_base_url\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!configured) return undefined;
  let url: URL;
  try { url = new URL(configured); } catch { return `Codex ayarındaki openai_base_url geçersiz: ${safeLog(configured)}`; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  return reachable ? undefined
    : `Codex model isteklerini ${url.host} adresindeki yerel köprüye/proxy'ye yolluyor ama orada çalışan bir şey yok. `
      + `O uygulamayı başlatın ya da ${join(home, "config.toml")} içindeki openai_base_url satırını kaldırın.`;
}

/** No thread/turn, model request, token refresh, or identity text is exported. */
export async function probeCodex(cwd: string, signal?: AbortSignal, factory?: ClientFactory,
  endpointCheck: (codexHome?: string) => Promise<string | undefined> = factory ? async () => undefined : codexEndpointProblem, codexHome?: string): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  let client: JsonlRpcClient | undefined;
  try {
    const options: Omit<RpcOptions, "executable" | "args"> = { cwd, signal, timeoutMs: 10000, requestTimeoutMs: 5000,
      maxOutputBytes: 1024 * 1024, onNotification() {}, async onRequest() { throw new Error("Probe cannot grant permissions"); }, onExit() {} };
    client = factory ? factory(options) : new JsonlRpcClient({ ...options,
      executable: process.platform === "win32" ? "codex.exe" : "codex", args: ["app-server"], env: codexEnv(codexHome) });
    await client.request("initialize", { clientInfo: { name: "agentmesh", title: "AgentMesh IDE", version: "0.1.0" } });
    client.notify("initialized");
    const result = await client.request("account/read", { refreshToken: false });
    const account = record(result.account);
    if (["apiKey", "chatgpt", "amazonBedrock"].includes(String(account.type))) {
      const problem = await endpointCheck(codexHome);
      if (problem) return { status: "needs_setup", checkedAt, detail: problem };
      return { status: "configured", checkedAt, detail: "Hesap kaydı bulundu; model erişimi ve kota sınanmadı." };
    }
    if (result.account === null && result.requiresOpenaiAuth === true) return { status: "needs_login", checkedAt,
      detail: "Codex CLI hesabına giriş gerekli." };
    return { status: "installed", checkedAt, detail: "App Server erişilebilir; bu sağlayıcının giriş durumu doğrulanamadı." };
  } catch {
    return { status: "unavailable", checkedAt, detail: signal?.aborted ? "Bağlantı kontrolü iptal edildi."
      : "Codex App Server açılamadı veya protokol doğrulanamadı; CLI kurulumunu kontrol edin." };
  } finally { await client?.close(); }
}

export async function probeOpenCode(cwd: string, signal?: AbortSignal): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await promisify(execFile)(defaultOpenCodeCommand(), ["--version"], {
      cwd, signal, timeout: 5000, maxBuffer: 8192, shell: false, windowsHide: true,
    });
    const version = result.stdout.trim().match(/\b\d+\.\d+\.\d+(?:[-\w.]*)?\b/)?.[0];
    return { status: "installed", checkedAt, detail: `OpenCode ${safeLog(version ?? "CLI")} bulundu; giriş durumu bu transportta doğrulanmıyor.` };
  } catch {
    return { status: "unavailable", checkedAt, detail: signal?.aborted ? "Bağlantı kontrolü iptal edildi." : "OpenCode CLI bulunamadı veya sürüm kontrolü başarısız." };
  }
}

export async function probeOpenCodeServer(cwd: string, model?: string, signal?: AbortSignal,
  factory: (options: OpenCodeServerOptions) => Promise<OpenCodeServerClient> = OpenCodeServerClient.start): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  let server: OpenCodeServerClient | undefined;
  try {
    server = await factory({ cwd, signal, timeoutMs: 30000 });
    const providers = record(await server.request("/provider"));
    if (!Array.isArray(providers.connected) || !providers.connected.every((entry) => typeof entry === "string")) throw new Error("Invalid provider response");
    const provider = model?.split("/")[0];
    const configured = provider ? providers.connected.includes(provider) : providers.connected.length > 0;
    return { status: configured ? "configured" : "needs_setup", checkedAt,
      detail: configured ? `OpenCode ${server.version}: sağlayıcı bağlantısı bildirildi; model erişimi ve kota sınanmadı.`
        : `OpenCode ${server.version}: seçilen sağlayıcı için bağlantı bulunamadı; sağlayıcı ayarlarını kontrol edin.` };
  } catch {
    return { status: "unavailable", checkedAt, detail: signal?.aborted ? "Bağlantı kontrolü iptal edildi."
      : "OpenCode Server bağlantısı, şeması veya çalışma dizini doğrulanamadı." };
  } finally { await server?.close(); }
}
