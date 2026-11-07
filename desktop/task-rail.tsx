import type { TaskRecord, TaskStatus } from "../src/core/contracts.js";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Sırada", running: "Çalışıyor", completed: "Tamamlandı", failed: "Başarısız", blocked: "Engellendi",
  pending_review: "İnceleme bekliyor", cancelled: "İptal edildi", needs_review: "Kontrol gerekli",
};

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "○", running: "◉", completed: "✓", failed: "✕", blocked: "⊘", pending_review: "◐", cancelled: "–", needs_review: "!",
};

export function TaskRail({ state, api, selected, pending, onSelect, onCreate, act }: {
  state: DesktopState;
  api: DesktopAPI;
  selected?: TaskRecord;
  pending: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  act: (action: () => Promise<unknown>) => void;
}) {
  const { tasks } = state.snapshot;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const waiting = tasks.filter((task) => task.status === "pending_review").length;

  return <aside className="task-rail" aria-label="Görevler">
    <div className="rail-heading">
      <h2>Görevler <span>{tasks.length}</span></h2>
      <button className="primary small" data-testid="create-task" disabled={state.busy || pending} onClick={onCreate}>＋ Yeni görev</button>
    </div>
    {!!tasks.length && <div className="rail-progress">
      <progress value={completed} max={tasks.length} aria-label="Tamamlanan görevler" />
      <small>{completed}/{tasks.length} tamamlandı{waiting ? ` · ${waiting} inceleme bekliyor` : ""}</small>
    </div>}

    <div className="task-list">
      {!tasks.length && <p className="rail-empty">Henüz görev yok.</p>}
      {tasks.map((task) => {
        const asking = state.permissions.some((request) => request.taskId === task.id);
        return <button key={task.id} className={`task-row ${selected?.id === task.id ? "selected" : ""}`} onClick={() => onSelect(task.id)}>
          <span className={`task-symbol ${task.status}`} aria-hidden>{STATUS_ICON[task.status]}</span>
          <span className="task-title">
            <strong>{task.title}</strong>
            <small>{task.agentId}{task.dependsOn.length ? ` · ${task.dependsOn.length} bağımlılık` : ""}</small>
          </span>
          <span className={`status ${asking ? "asking" : task.status}`}>{asking ? "İzin bekliyor" : STATUS_LABEL[task.status]}</span>
        </button>;
      })}
    </div>

    <div className="rail-foot">
      <label className="parallel-control">Paralel ajan
        <select aria-label="Paralel ajan sayısı" value={state.maxParallel} disabled={state.busy || pending}
          onChange={(event) => act(() => api.setParallelism(Number(event.target.value)))}>
          {Array.from({ length: 8 }, (_, index) => <option value={index + 1} key={index + 1}>{index + 1}</option>)}
        </select>
      </label>
      <ul className="agent-list" aria-label="Ajanlar">
        {state.agents.map((agent) => {
          const working = tasks.some((task) => task.agentId === agent.id && task.status === "running");
          return <li className="agent" key={agent.id}>
            <span className={`agent-dot ${working ? "active" : ""}`} />
            <strong>{agent.id}</strong>
            <small>{state.demo ? "demo" : [agent.provider, agent.codexHome && state.codexProfiles.find((profile) => profile.path === agent.codexHome)?.name, agent.model].filter(Boolean).join(" · ")}</small>
          </li>;
        })}
      </ul>
    </div>
  </aside>;
}
