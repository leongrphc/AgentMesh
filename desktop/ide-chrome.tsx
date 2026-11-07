import type { ReactNode } from "react";
import type { DesktopState } from "../src/desktop/contracts.js";
import { laneStyle } from "./lanes.js";

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" aria-hidden className="icon">{children}</svg>;
}

/** Leftmost strip, as in most IDEs: toggles the sidebar and bottom panel, opens the agent center. */
export function ActivityBar({ sidebar, panel, onSidebar, onPanel, onAgents, agentsNeedAttention }: {
  sidebar: boolean;
  panel: boolean;
  onSidebar: () => void;
  onPanel: () => void;
  onAgents: () => void;
  agentsNeedAttention: boolean;
}) {
  return <nav className="activity-bar" aria-label="Görünümler">
    <button className={sidebar ? "on" : ""} aria-pressed={sidebar} title="Görevler (Ctrl+B)" aria-label="Görevler paneli" onClick={onSidebar}>
      <Icon><path d="M6 3v18" /><circle cx="6" cy="7" r="2.2" /><circle cx="6" cy="17" r="2.2" /><path d="M11 7h8M11 17h8M11 12h5" /></Icon>
    </button>
    <button className={panel ? "on" : ""} aria-pressed={panel} title="Terminal ve akış (Ctrl+J)" aria-label="Alt panel" onClick={onPanel}>
      <Icon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18M7 17.5h4" /></Icon>
    </button>
    <span className="activity-spacer" />
    <button data-testid="agent-center" title="Ajanlar ve bağlantılar" aria-label="Ajanlar" onClick={onAgents}>
      <Icon><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5" /><path d="M16 5.5a3 3 0 0 1 0 5M17.5 14.3c1.6.7 2.7 2.3 3 4.7" /></Icon>
      {agentsNeedAttention && <span className="badge" aria-label="Kontrol edilmemiş bağlantı" />}
    </button>
  </nav>;
}

/** Bottom strip with the facts worth a glance: activity, integration branch, agent lines, parallelism. */
export function StatusBar({ state }: { state: DesktopState }) {
  const running = state.snapshot.tasks.filter((task) => task.status === "running");
  const review = state.snapshot.tasks.filter((task) => task.status === "pending_review").length;
  return <footer className="status-bar" role="status">
    <span className={`sb-item ${state.busy ? "live" : ""}`}><span className="status-light" />{state.busy ? `${running.length} ajan çalışıyor` : "Boşta"}</span>
    {state.integrationBranch && <span className="sb-item" title="Onaylı işlerin toplandığı dal">
      <svg viewBox="0 0 24 24" aria-hidden className="icon small-icon"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-12 6" /></svg>
      <code>{state.integrationBranch}</code>
      {state.integrationPending > 0 && <b className="sb-pending">{state.integrationPending} uygulanmayı bekliyor</b>}
    </span>}
    {review > 0 && <span className="sb-item sb-review">{review} inceleme bekliyor</span>}
    <span className="sb-spacer" />
    {state.agents.map((agent) => <span key={agent.id} className="sb-item sb-agent" style={laneStyle(state, agent.id)}
      title={running.some((task) => task.agentId === agent.id) ? `${agent.id} çalışıyor` : agent.id}>
      <span className={`sb-line ${running.some((task) => task.agentId === agent.id) ? "active" : ""}`} />{agent.id}
    </span>)}
    <span className="sb-item">En fazla {state.maxParallel} paralel</span>
    {state.uncommittedChanges && <span className="sb-item sb-warn">Commit edilmemiş değişiklik</span>}
  </footer>;
}
