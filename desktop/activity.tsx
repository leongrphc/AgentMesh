import { useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import { ContextPanel } from "./context-panel.js";
import { taskLaneStyle } from "./lanes.js";
import { Messages } from "./messages.js";

type Tab = "events" | "context" | "messages";

export function Activity({ state, api, taskId, tab, onTab }: {
  state: DesktopState;
  api: DesktopAPI;
  taskId?: string;
  tab: Tab;
  onTab: (tab: Tab) => void;
}) {
  const [selectedOnly, setSelectedOnly] = useState(false);
  const { project, context } = state.snapshot;
  const events = [...state.events].reverse().filter((event) => !selectedOnly || event.taskId === taskId);
  const tabs: Array<[Tab, string, number]> = [
    ["events", "Akış", state.events.length],
    ["context", "Ortak bilgi", Object.keys(context).length],
    ["messages", "Mesajlar", state.historyCounts.messages],
  ];

  return <section className="activity" aria-label="Proje etkinliği">
    <div className="activity-header">
      <div role="tablist" aria-label="Proje kayıtları">
        {tabs.map(([id, label, count]) => <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id}
          aria-controls={`panel-${id}`} onClick={() => onTab(id)}>{label}<span>{count}</span></button>)}
      </div>
      <label className="history-filter" title="Yalnızca seçili görevin kayıtlarını göster">
        <input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />Seçili görev
      </label>
    </div>
    <div className="activity-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === "events" && (events.length
        ? <ol className="event-list">{events.map((event, index) => <li className="event" key={`${event.at}-${index}`} style={taskLaneStyle(state, event.taskId)}>
          <time>{new Date(event.at).toLocaleTimeString("tr-TR")}</time>
          <span className="event-task">{event.taskId ?? "proje"}</span>
          <p>{event.text}</p>
        </li>)}</ol>
        : <div className="empty"><b>Akış boş.</b><p>Ajanlar çalışırken okudukları, değiştirdikleri ve bildirdikleri burada sırayla görünür.</p></div>)}
      {tab === "context" && <ContextPanel key={project.id + project.workspaceRoot} state={state} api={api} />}
      {tab === "messages" && <Messages key={project.id + project.workspaceRoot} state={state} api={api} taskId={taskId} selectedOnly={selectedOnly} />}
    </div>
  </section>;
}
