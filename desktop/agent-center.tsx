import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import type { ProviderMessageResult } from "../src/adapters/provider-message.js";

export function AgentCenter({ state, api, onClose }: { state: DesktopState; api: DesktopAPI; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<"codex" | "opencode">("codex");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState("Selam");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ProviderMessageResult>();
  const [sentMessage, setSentMessage] = useState("");
  function close() { if (sending) void api.cancelProviderTest(); onClose(); }
  useEffect(() => { dialog.current?.showModal(); }, []);
  const labels = { configured: "Yapılandırıldı", needs_login: "Giriş gerekli", needs_setup: "Bağlantı gerekli", installed: "CLI bulundu", unavailable: "Erişilemiyor" };
  return <dialog ref={dialog} className="review-dialog agent-center" aria-labelledby="agent-center-title" onCancel={close}>
    <div className="review-header"><div><div className="eyebrow">BAĞLANTILAR</div><h2 id="agent-center-title">Ajan merkezi</h2></div><button aria-label="Ajan merkezini kapat" onClick={close}>×</button></div>
    <div className="review-content"><p className="agent-center-intro">Sağlayıcı ve modeller proje ayarlarından gelir. Bağlantı kontrolü model çağırmaz; hesap kaydının bulunması model erişimi veya kota garantisi vermez.</p>
      {error && <p className="file-error" role="alert">{error}</p>}
      <section className="provider-test" aria-labelledby="provider-test-title">
        <h3 id="provider-test-title">Gerçek mesaj testi</h3>
        <p>Codex veya OpenCode hesabına mesaj gönder, yanıtı burada gör. Demo projesinde de gerçek sağlayıcı kullanılır; kullanım maliyeti oluşabilir. Her gönderim bağımsız bir konuşmadır.</p>
        <form onSubmit={async (event) => {
          event.preventDefault(); setError(""); setResult(undefined); setSending(true); setSentMessage(message);
          try { setResult(await api.testProvider({ provider, message, ...(model.trim() ? { model: model.trim() } : {}) })); }
          catch (e) { setError(String(e)); } finally { setSending(false); }
        }}>
          <div className="provider-test-fields"><label>Sağlayıcı<select aria-label="Test sağlayıcısı" value={provider} disabled={sending} onChange={(e) => { setProvider(e.target.value as "codex" | "opencode"); setModel(""); }}><option value="codex">Codex · App Server</option><option value="opencode">OpenCode · Server</option></select></label>
          <label>Model (isteğe bağlı)<input aria-label="Test modeli" value={model} disabled={sending} maxLength={200} placeholder={provider === "opencode" ? "provider/model veya varsayılan" : "Sağlayıcı varsayılanı"} onChange={(e) => setModel(e.target.value)} /></label></div>
          <label>Mesaj<textarea aria-label="Test mesajı" maxLength={2000} rows={3} value={message} disabled={sending} onChange={(e) => setMessage(e.target.value)} /></label>
          <div className="provider-test-actions"><small>Proje dosyaları gönderilmez. En fazla 90 saniye beklenir.</small>{sending && <button type="button" onClick={() => void api.cancelProviderTest()}>Testi iptal et</button>}<button type="submit" className="primary" data-testid="send-provider-message" disabled={sending || !!state.testingProvider || state.busy || state.checkingAgents || !message.trim()}>{sending ? "Yanıt bekleniyor…" : "Mesajı gönder · gerçek model"}</button></div>
        </form>
        {result && <div className="provider-test-result" role="status"><small>{result.provider} · {result.model ?? "Varsayılan model"} · {(result.elapsedMs / 1000).toFixed(1)} sn · Yanıt alındı</small><p><b>Sen:</b> {sentMessage}</p><pre>{result.response}</pre></div>}
      </section>
      {state.agents.map((agent) => { const health = state.health[agent.id]; return <article className="agent-card" key={agent.id}>
        <div className="agent-card-header"><h3>{agent.id}</h3><span className={`health-status ${health?.status ?? "unchecked"}`}>{health ? labels[health.status] : "Kontrol edilmedi"}</span></div>
        <dl><dt>Sağlayıcı</dt><dd>{state.demo ? "Mock" : agent.provider}</dd><dt>Bağlantı</dt><dd>{state.demo ? "Yerel demo" : agent.transport === "app-server" ? "CLI / App Server" : agent.transport === "server" ? "CLI / HTTP Server" : "CLI / exec"}</dd><dt>Model</dt><dd>{agent.model ?? (state.demo ? "Kullanılmaz" : "Sağlayıcı varsayılanı")}</dd><dt>Görev rolü</dt><dd>{agent.id}</dd><dt>Araç izinleri</dt><dd>{agent.interactivePermissions ? "Kullanıcı kararı · tek istek" : "Etkileşimli izin desteklenmiyor"}</dd></dl>
        {health && <><p>{health.detail}</p><small>Son kontrol: {new Date(health.checkedAt).toLocaleString("tr-TR")}</small></>}
      </article>; })}
    </div><div className="review-actions"><button data-testid="check-agents" className="primary" disabled={state.busy || state.checkingAgents} onClick={async () => { setError(""); try { await api.checkAgents(); } catch (e) { setError(String(e)); } }}>{state.checkingAgents ? "Kontrol ediliyor…" : "Bağlantıları kontrol et"}</button></div>
  </dialog>;
}
