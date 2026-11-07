import { useEffect, useRef } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

const SOURCE_LABEL: Record<DesktopState["source"], string> = { demo: "Demo", folder: "Git projesi", config: "Config projesi" };

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
  const { project } = state.snapshot;
  const current = project.workspaceRoot.toLowerCase();

  return <details className="project-menu" ref={menu}>
    <summary aria-label="Proje değiştir">
      <span className="project-avatar" aria-hidden>{(state.demo ? "D" : project.workspaceRoot.split(/[\\/]/).pop() ?? "P").slice(0, 1).toUpperCase()}</span>
      <span className="project-label">
        <strong>{state.demo ? "Demo projesi" : project.workspaceRoot.split(/[\\/]/).pop()}</strong>
        <small title={project.workspaceRoot}>{state.demo ? "Model çağırmaz" : project.workspaceRoot}</small>
      </span>
      <span className="chevron" aria-hidden>▾</span>
    </summary>
    <div className="menu-panel" role="menu">
      <button role="menuitem" className="menu-primary" disabled={disabled} onClick={() => run(() => api.openFolder())}>
        <b>Klasör aç…</b><small>Herhangi bir Git deposunu proje olarak aç</small>
      </button>
      {!!state.recent.length && <div className="menu-label">Son projeler</div>}
      {state.recent.map((item) => <button role="menuitem" key={item.path} disabled={disabled || item.path.toLowerCase() === current}
        onClick={() => run(() => api.openRecent(item.path))}>
        <b>{item.name}</b><small>{item.path}</small>
      </button>)}
      <div className="menu-label">Diğer</div>
      <button role="menuitem" disabled={disabled} onClick={() => run(() => api.openConfig())}>
        <b>Config dosyası aç…</b><small>agentmesh.config.json ile hazır görevler</small>
      </button>
      <button role="menuitem" disabled={disabled || state.demo} onClick={() => run(() => api.openDemo())}>
        <b>Demo projesi</b><small>Gerçek model çağırmayan örnek akış</small>
      </button>
    </div>
  </details>;
}

export function TopBar({ state, api, pending, ready, blocked, guard, act, onAgents, onStart }: {
  state: DesktopState;
  api: DesktopAPI;
  pending: boolean;
  ready: boolean;
  blocked: boolean;
  guard: () => boolean;
  act: (action: () => Promise<unknown>) => void;
  onAgents: () => void;
  onStart: () => void;
}) {
  const running = state.snapshot.tasks.filter((task) => task.status === "running").length;
  return <header className="topbar">
    <div className="brand" aria-label="AgentMesh"><span className="brand-mark" aria-hidden>◆</span>AgentMesh</div>
    <ProjectMenu state={state} api={api} disabled={state.busy || pending} guard={guard} act={act} />
    <span className={`mode-tag ${state.source}`}>{SOURCE_LABEL[state.source]}</span>
    <div className="topbar-status" role="status">
      <span className={`status-light ${state.busy ? "on" : ""}`} />
      {state.busy ? `${running} ajan çalışıyor` : "Hazır"}
    </div>
    <div className="run-actions">
      <button data-testid="agent-center" onClick={onAgents}>Ajanlar <span className="count">{state.agents.length}</span></button>
      <button disabled={!state.busy || pending} onClick={() => act(() => api.cancel())}>Durdur</button>
      <button className="primary" data-testid="start" disabled={state.busy || !ready || pending || blocked} onClick={onStart}>
        {state.busy ? "Çalışıyor…" : "▶ Ajanları başlat"}
      </button>
    </div>
  </header>;
}
