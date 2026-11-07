import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import type { ProviderMessageInput, ProviderMessageResult } from "../src/adapters/provider-message.js";
import type { TerminalInfo } from "../src/desktop/terminals.js";
import { AgentSettings } from "./agent-settings.js";
const NativeTerminal = lazy(() => import("./terminal.js").then((module) => ({ default: module.TerminalView })));

export function AgentCenter({ state, api, onClose }: { state: DesktopState; api: DesktopAPI; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<ProviderMessageInput["provider"]>("codex");
  const [model, setModel] = useState("");
  const [transport, setTransport] = useState<"terminal" | "exec" | "server">("terminal");
  const [native, setNative] = useState<TerminalInfo>();
  const nativeRef = useRef<TerminalInfo>(undefined);
  const live = useRef(true);
  const [message, setMessage] = useState("Selam");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ProviderMessageResult>();
  const [sentMessage, setSentMessage] = useState("");
  function close() { if (sending) void api.cancelProviderTest(); onClose(); }
  useEffect(() => { dialog.current?.showModal(); return () => {
    live.current = false;
    if (nativeRef.current) void api.terminalClose(nativeRef.current.id).catch(() => {});
  }; }, [api]);
  const labels = { configured: "Yapılandırıldı", needs_login: "Giriş gerekli", needs_setup: "Bağlantı gerekli", installed: "CLI bulundu", unavailable: "Erişilemiyor" };
  return <dialog ref={dialog} className={`review-dialog agent-center${native ? " native-mode" : ""}`} aria-labelledby="agent-center-title" onCancel={close}>
    <div className="review-header"><div><div className="eyebrow">BAĞLANTILAR</div><h2 id="agent-center-title">Ajan merkezi</h2></div><button aria-label="Ajan merkezini kapat" onClick={close}>×</button></div>
    <div className="review-content"><p className="agent-center-intro">Bağlantı kontrolü model çağırmaz; hesap kaydının bulunması model erişimi veya kota garantisi vermez.</p>
      {error && <p className="file-error" role="alert">{error}</p>}
      {state.agents.map((agent) => { const health = state.health[agent.id]; return <article className="agent-card" key={agent.id}>
        <div className="agent-card-header"><h3>{agent.id}</h3><span className={`health-status ${health?.status ?? "unchecked"}`}>{health ? labels[health.status] : "Kontrol edilmedi"}</span></div>
        <dl><dt>Sağlayıcı</dt><dd>{state.demo ? "Mock" : agent.provider}</dd><dt>Bağlantı</dt><dd>{state.demo ? "Yerel demo" : agent.transport === "app-server" ? "CLI / App Server" : agent.transport === "server" ? "CLI / HTTP Server" : "CLI / exec"}</dd><dt>Model</dt><dd>{agent.model ?? (state.demo ? "Kullanılmaz" : "Sağlayıcı varsayılanı")}</dd><dt>Görev rolü</dt><dd>{agent.role ?? agent.id}</dd><dt>Araç izinleri</dt><dd>{agent.interactivePermissions ? "Kullanıcı kararı · tek istek" : "Etkileşimli izin desteklenmiyor"}</dd></dl>
        {health && <><p>{health.detail}</p><small>Son kontrol: {new Date(health.checkedAt).toLocaleString("tr-TR")}</small></>}
        <p>Proje mesajları: {agent.liveMessages ? "Aktif göreve canlı teslim desteklenir" : "Sonraki görev veya yeniden denemede teslim edilir"}.</p>
      </article>; })}
      <AgentSettings state={state} api={api} />
      <section className="provider-test" aria-labelledby="provider-test-title">
        <h3 id="provider-test-title">Gerçek mesaj testi</h3>
        <p>Bir sağlayıcıya mesaj gönder, yanıtı burada gör. Demo projesinde de gerçek sağlayıcı kullanılır; kullanım maliyeti oluşabilir. Tek mesaj testleri bağımsız konuşmalardır.</p>
        <form onSubmit={async (event) => {
          event.preventDefault(); setError(""); setResult(undefined); setSending(true); setSentMessage(message);
          try {
            if (provider === "opencode" && transport === "terminal") {
              const info = await api.openProviderTerminal(model.trim() || undefined);
              if (!live.current) { await api.terminalClose(info.id); return; }
              nativeRef.current = info; setNative(info);
            } else setResult(await api.testProvider({ provider, message, ...(provider === "opencode" ? { transport: transport as "exec" | "server" } : {}), ...(model.trim() ? { model: model.trim() } : {}) }));
          }
          catch (e) { setError(String(e)); } finally { setSending(false); }
        }}>
          <div className="provider-test-fields"><label>Sağlayıcı<select aria-label="Test sağlayıcısı" value={provider} disabled={sending || !!native} onChange={(e) => { setProvider(e.target.value as ProviderMessageInput["provider"]); setModel(e.target.value === "opencode" ? "opencode/space-bunny-free" : ""); }}><option value="codex">Codex · App Server</option><option value="opencode">OpenCode</option><option value="antigravity">Antigravity · CLI</option><option value="claude">Claude · API anahtarı</option></select></label>
          <label>Model (isteğe bağlı)<input aria-label="Test modeli" value={model} disabled={sending || !!native} maxLength={200} placeholder={provider === "opencode" ? "provider/model veya varsayılan" : "Sağlayıcı varsayılanı"} onChange={(e) => setModel(e.target.value)} /></label></div>
          {provider === "opencode" && <label>Bağlantı<select aria-label="OpenCode test bağlantısı" value={transport} disabled={sending || !!native} onChange={(e) => setTransport(e.target.value as typeof transport)}><option value="terminal">Etkileşimli terminal · Free modeller için</option><option value="exec">CLI run · tek mesaj</option><option value="server">HTTP Server · tek mesaj</option></select></label>}
          {provider === "opencode" && transport !== "terminal" && <p className="terminal-note">Bazı Free modeller tek mesaj bağlantısını reddedebilir. Böyle bir hatada Etkileşimli terminal seçeneğini kullanın.</p>}
          {provider === "opencode" && transport === "terminal" ? <p className="terminal-note">OpenCode’un kendi ekranı açılır. Terminale tıkla, Selam yaz ve Enter’a bas. Yerel CLI hesabın ve OpenCode izin ekranları kullanılır. Bu oturum proje dışında açılır; kapatana kadar devam eder.</p> : <label>Mesaj<textarea aria-label="Test mesajı" maxLength={2000} rows={3} value={message} disabled={sending} onChange={(e) => setMessage(e.target.value)} /></label>}
          <div className="provider-test-actions"><small>{provider === "opencode" && transport === "terminal" ? "Normal kullanıcı yetkileriyle native OpenCode." : "Proje dosyaları gönderilmez. En fazla 90 saniye beklenir."}</small>{sending && <button type="button" onClick={() => void api.cancelProviderTest()}>Testi iptal et</button>}<button type="submit" className="primary" data-testid="send-provider-message" disabled={sending || !!native || !!state.testingProvider || state.busy || state.checkingAgents || !message.trim()}>{sending ? "Hazırlanıyor…" : provider === "opencode" && transport === "terminal" ? "OpenCode terminalini aç" : "Mesajı gönder · gerçek model"}</button></div>
        </form>
        {native && <div className="provider-tui" data-native-terminal-id={native.id}><button type="button" data-testid="close-native-opencode" onClick={async () => {
          try { await api.terminalClose(native.id); nativeRef.current = undefined; setNative(undefined); }
          catch (e) { setError(String(e)); }
        }}>OpenCode oturumunu kapat</button><Suspense fallback={<p>Terminal yükleniyor…</p>}><NativeTerminal info={native} api={api} visible autoFocus /></Suspense></div>}
        {result && <div className="provider-test-result" role="status"><small>{result.provider}{result.transport ? ` / ${result.transport}` : ""} · {result.model ?? "Varsayılan model"} · {(result.elapsedMs / 1000).toFixed(1)} sn · Yanıt alındı</small><p><b>Sen:</b> {sentMessage}</p><pre>{result.response}</pre></div>}
      </section>
    </div><div className="review-actions"><button data-testid="check-agents" className="primary" disabled={state.busy || state.checkingAgents} onClick={async () => { setError(""); try { await api.checkAgents(); } catch (e) { setError(String(e)); } }}>{state.checkingAgents ? "Kontrol ediliyor…" : "Bağlantıları kontrol et"}</button></div>
  </dialog>;
}
