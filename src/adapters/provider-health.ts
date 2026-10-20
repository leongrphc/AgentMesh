import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonlRpcClient, record, type RpcOptions } from "./jsonl-rpc.js";
import { defaultOpenCodeCommand } from "./opencode-cli.js";
import { safeLog } from "../core/safe-log.js";
import { OpenCodeServerClient, type OpenCodeServerOptions } from "./opencode-server-client.js";
import { headlessCommand, type HeadlessProvider } from "./headless-cli.js";

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
    if (provider === "claude" && !process.env.ANTHROPIC_API_KEY?.trim()) return { status: "needs_setup", checkedAt,
      detail: `Claude CLI ${version} bulundu. Ürün entegrasyonu için ANTHROPIC_API_KEY gerekli; abonelik OAuth girişi kullanılmaz.` };
    return { status: "installed", checkedAt, detail: `${provider === "antigravity" ? "Antigravity" : "Claude Code"} ${version} bulundu; giriş, model erişimi ve kota sınanmadı. Native headless politikaları geçerlidir; etkileşimli izin köprüsü yok.` };
  } catch { return { status: "unavailable", checkedAt, detail: signal?.aborted ? "Kontrol iptal edildi." : `${provider} CLI açılamadı; kurulumu ve PATH ayarını kontrol edin.` }; }
}
type ClientFactory = (options: Omit<RpcOptions, "executable" | "args">) => JsonlRpcClient;

/** No thread/turn, model request, token refresh, or identity text is exported. */
export async function probeCodex(cwd: string, signal?: AbortSignal, factory?: ClientFactory): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  let client: JsonlRpcClient | undefined;
  try {
    const options: Omit<RpcOptions, "executable" | "args"> = { cwd, signal, timeoutMs: 10000, requestTimeoutMs: 5000,
      maxOutputBytes: 1024 * 1024, onNotification() {}, async onRequest() { throw new Error("Probe cannot grant permissions"); }, onExit() {} };
    client = factory ? factory(options) : new JsonlRpcClient({ ...options,
      executable: process.platform === "win32" ? "codex.exe" : "codex", args: ["app-server"] });
    await client.request("initialize", { clientInfo: { name: "agentmesh", title: "AgentMesh IDE", version: "0.1.0" } });
    client.notify("initialized");
    const result = await client.request("account/read", { refreshToken: false });
    const account = record(result.account);
    if (["apiKey", "chatgpt", "amazonBedrock"].includes(String(account.type))) return { status: "configured", checkedAt,
      detail: "Hesap kaydı bulundu; model erişimi ve kota sınanmadı." };
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
