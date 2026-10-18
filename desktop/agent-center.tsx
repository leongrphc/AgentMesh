import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

export function AgentCenter({ state, api, onClose }: { state: DesktopState; api: DesktopAPI; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const labels = { configured: "Yapılandırıldı", needs_login: "Giriş gerekli", needs_setup: "Bağlantı gerekli", installed: "CLI bulundu", unavailable: "Erişilemiyor" };
  return <dialog ref={dialog} className="review-dialog agent-center" aria-labelledby="agent-center-title" onCancel={onClose}>
    <div className="review-header"><div><div className="eyebrow">BAĞLANTILAR</div><h2 id="agent-center-title">Ajan merkezi</h2></div><button aria-label="Ajan merkezini kapat" onClick={onClose}>×</button></div>
    <div className="review-content"><p className="agent-center-intro">Sağlayıcı ve modeller proje ayarlarından gelir. Bağlantı kontrolü model çağırmaz; hesap kaydının bulunması model erişimi veya kota garantisi vermez.</p>
      {error && <p className="file-error" role="alert">{error}</p>}
      {state.agents.map((agent) => { const health = state.health[agent.id]; return <article className="agent-card" key={agent.id}>
        <div className="agent-card-header"><h3>{agent.id}</h3><span className={`health-status ${health?.status ?? "unchecked"}`}>{health ? labels[health.status] : "Kontrol edilmedi"}</span></div>
        <dl><dt>Sağlayıcı</dt><dd>{state.demo ? "Mock" : agent.provider}</dd><dt>Bağlantı</dt><dd>{state.demo ? "Yerel demo" : agent.transport === "app-server" ? "CLI / App Server" : agent.transport === "server" ? "CLI / HTTP Server" : "CLI / exec"}</dd><dt>Model</dt><dd>{agent.model ?? (state.demo ? "Kullanılmaz" : "Sağlayıcı varsayılanı")}</dd><dt>Görev rolü</dt><dd>{agent.id}</dd><dt>Araç izinleri</dt><dd>{agent.interactivePermissions ? "Kullanıcı kararı · tek istek" : "Etkileşimli izin desteklenmiyor"}</dd></dl>
        {health && <><p>{health.detail}</p><small>Son kontrol: {new Date(health.checkedAt).toLocaleString("tr-TR")}</small></>}
      </article>; })}
    </div><div className="review-actions"><button data-testid="check-agents" className="primary" disabled={state.busy || state.checkingAgents} onClick={async () => { setError(""); try { await api.checkAgents(); } catch (e) { setError(String(e)); } }}>{state.checkingAgents ? "Kontrol ediliyor…" : "Bağlantıları kontrol et"}</button></div>
  </dialog>;
}
