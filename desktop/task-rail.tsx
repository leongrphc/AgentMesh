import type { TaskRecord, TaskStatus } from "../src/core/contracts.js";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import { laneStyle } from "./lanes.js";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Sırada", running: "Çalışıyor", completed: "Tamamlandı", failed: "Başarısız", blocked: "Engellendi",
  pending_review: "İnceleme bekliyor", cancelled: "İptal edildi", needs_review: "Kontrol gerekli",
};

/**
 * The rail is drawn as a line map: each agent is a coloured line, each task a stop on it.
 * The stop's shape carries the status (see .stop in style.css); the list ends at the
 * integration terminus where approved work waits to be applied to the project.
 */
export function TaskRail({ state, api, selected, pending, onSelect, onCreate, onPlan, act }: {
  state: DesktopState;
  api: DesktopAPI;
  selected?: TaskRecord;
  pending: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onPlan: () => void;
  act: (action: () => Promise<unknown>) => void;
}) {
  const { tasks } = state.snapshot;
  const done = tasks.filter((task) => task.status === "completed").length;

  return <aside className="task-rail" aria-label="Görevler">
    <header className="rail-heading">
      <div>
        <h2>Görevler</h2>
        <small>{tasks.length ? `${done} / ${tasks.length} tamamlandı` : "Henüz görev yok"}</small>
      </div>
      <div className="rail-actions">
        <button className="small" data-testid="plan-tasks" disabled={state.busy || pending} onClick={onPlan} title="Bir hedefi ajan görevlere bölsün">Planla</button>
        <button className="primary small" data-testid="create-task" disabled={state.busy || pending} onClick={onCreate}>Yeni görev</button>
      </div>
    </header>

    {!!tasks.length && <div className="rail-meter" aria-hidden>
      {tasks.map((task) => <span key={task.id} className={`meter-cell ${task.status}`} style={laneStyle(state, task.agentId)} />)}
    </div>}

    <div className="task-list">
      {tasks.map((task) => {
        const asking = state.permissions.some((request) => request.taskId === task.id);
        const waitsFor = task.dependsOn.map((id) => tasks.find((other) => other.id === id)?.title ?? id);
        return <button key={task.id} style={laneStyle(state, task.agentId)}
          className={`task-row ${selected?.id === task.id ? "selected" : ""}`} onClick={() => onSelect(task.id)}>
          <span className={`task-symbol stop ${asking ? "asking" : task.status}`} aria-hidden>
            {task.status === "completed" ? "✓" : ["failed", "blocked", "needs_review"].includes(task.status) ? "×" : ""}
          </span>
          <span className="task-title">
            <strong>{task.title}</strong>
            <small><span className="agent-name">{task.agentId}</span>{waitsFor.length ? ` · ${waitsFor.join(", ")} sonrası` : ""}</small>
          </span>
          <span className={`status ${asking ? "asking" : task.status}`}>{asking ? "İzin bekliyor" : STATUS_LABEL[task.status]}</span>
        </button>;
      })}
      {!state.demo && !!tasks.length && <div className={`terminus ${state.integrationPending ? "waiting" : ""}`}>
        <span className="stop terminus-stop" aria-hidden />
        <span>
          <strong>Entegrasyon</strong>
          <small>{state.integrationPending ? `${state.integrationPending} onaylı commit uygulanmayı bekliyor` : "Projeyle güncel"}</small>
        </span>
      </div>}
    </div>

    <footer className="rail-foot">
      <ul className="agent-list" aria-label="Ajan hatları">
        {state.agents.map((agent) => {
          const working = tasks.some((task) => task.agentId === agent.id && task.status === "running");
          const profile = agent.codexHome && state.codexProfiles.find((item) => item.path === agent.codexHome)?.name;
          return <li className="agent" key={agent.id} style={laneStyle(state, agent.id)}>
            <span className={`agent-line ${working ? "active" : ""}`} />
            <strong>{agent.id}</strong>
            <small>{state.demo ? "demo" : [agent.provider, profile, agent.model].filter(Boolean).join(" · ")}</small>
          </li>;
        })}
      </ul>
      <label className="parallel-control">Aynı anda en fazla
        <select aria-label="Paralel ajan sayısı" value={state.maxParallel} disabled={state.busy || pending}
          onChange={(event) => act(() => api.setParallelism(Number(event.target.value)))}>
          {Array.from({ length: 8 }, (_, index) => <option value={index + 1} key={index + 1}>{index + 1} ajan</option>)}
        </select>
      </label>
    </footer>
  </aside>;
}
