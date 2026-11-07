import { useEffect, useRef } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

const SOURCE_LABEL: Record<DesktopState["source"], string> = { demo: "Demo", folder: "Git projesi", config: "Config projesi" };

/** Two lines meeting at one stop: parallel branches merging, which is what the app does. */
function Mark() {
  return <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden>
    <path d="M4 4 C4 12, 12 10, 12 20" />
    <path d="M20 4 C20 12, 12 10, 12 20" />
    <circle cx="12" cy="20" r="2.6" />
  </svg>;
}

/** Project switcher: open a folder, reopen a recent one, load a config file or return to the demo. */
function ProjectMenu({ state, api, disabled, guard, act }: {
  state: DesktopState;
  api: DesktopAPI;
  disabled: boolean;
  guard: () => boolean;
  act: (action: () => Promise<unknown>) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const run = (action: () => Promise<unknown>) => {
    if (menu.current) menu.current.open = false;
    if (guard()) act(action);
  };
  const root = state.snapshot.project.workspaceRoot;
  const name = state.demo ? "Demo projesi" : root.split(/[\\/]/).pop();

  return <details className="project-menu" ref={menu}>
    <summary aria-label="Proje değiştir">
      <span className="project-label">
        <strong>{name}</strong>
        <small className={state.demo ? "" : "path"} title={root}>{state.demo ? "Örnek akış · model çağırmaz" : root}</small>
      </span>
      <span className="chevron" aria-hidden>▾</span>
    </summary>
    <div className="menu-panel" role="menu">
      <button role="menuitem" className="menu-primary" disabled={disabled} onClick={() => run(() => api.openFolder())}>
        <b>Klasör aç…</b><small>Herhangi bir proje klasörünü aç; Git deposu değilse başlatılır</small>
      </button>
      {!!state.recent.length && <div className="menu-label">Son projeler</div>}
      {state.recent.map((item) => <button role="menuitem" key={item.path} disabled={disabled || item.path.toLowerCase() === root.toLowerCase()}
        onClick={() => run(() => api.openRecent(item.path))}>
        <b>{item.name}</b><small>{item.path}</small>
      </button>)}
      <div className="menu-label">Diğer</div>
      <button role="menuitem" disabled={disabled} onClick={() => run(() => api.openConfig())}>
        <b>Config dosyası aç…</b><small>Görevleri hazır bir agentmesh.config.json dosyasından yükle</small>
      </button>
      <button role="menuitem" disabled={disabled || state.demo} onClick={() => run(() => api.openDemo())}>
        <b>Demo projesi</b><small>Gerçek model çağırmayan örnek akış</small>
      </button>
    </div>
  </details>;
}

export function TopBar({ state, api, pending, ready, blocked, guard, act, onStart }: {
  state: DesktopState;
  api: DesktopAPI;
  pending: boolean;
  ready: boolean;
  blocked: boolean;
  guard: () => boolean;
  act: (action: () => Promise<unknown>) => void;
  onStart: () => void;
}) {
  const running = state.snapshot.tasks.filter((task) => task.status === "running").length;
  return <header className="topbar">
    <div className="brand"><Mark /><span>AgentMesh</span></div>
    <span className="topbar-divider" aria-hidden />
    <ProjectMenu state={state} api={api} disabled={state.busy || pending} guard={guard} act={act} />
    <span className={`mode-tag ${state.source}`}>{SOURCE_LABEL[state.source]}</span>
    <div className={`topbar-status ${state.busy ? "live" : ""}`} role="status">
      <span className="status-light" />
      {state.busy ? `${running} ajan çalışıyor` : "Boşta"}
    </div>
    <div className="run-actions">
      {state.busy && <button disabled={pending} onClick={() => act(() => api.cancel())}>Durdur</button>}
      <button className="primary" data-testid="start" disabled={state.busy || !ready || pending || blocked} onClick={onStart}>
        {state.busy ? "Çalışıyor…" : "▶ Ajanları başlat"}
      </button>
    </div>
  </header>;
}
