import type { TaskRecord } from "../src/core/contracts.js";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import { ContextPackages } from "./context-packages.js";
import { laneStyle } from "./lanes.js";
import { STATUS_LABEL } from "./task-rail.js";
import { TestReports } from "./test-reports.js";

/** What the user should do next for a task, in one sentence. */
function nextStep(task: TaskRecord, busy: boolean): string | undefined {
  switch (task.status) {
    case "pending": return busy ? "Sırada. Önceki görevler bitince başlayacak." : "Hazır. Başlatmak için üstteki “Ajanları başlat” düğmesini kullanın.";
    case "running": return "Ajan çalışıyor. Neler yaptığını sağdaki akıştan izleyebilirsiniz.";
    case "pending_review": return "Ajan işini bitirdi. Değişiklikleri inceleyip onaylayın; bu göreve bağlı görevler onaydan sonra başlar.";
    case "failed": case "blocked": case "needs_review": return "Görev tamamlanamadı. Aşağıdaki hatayı okuyun, gerekirse görevi yeniden sıraya alın.";
    case "cancelled": return "Görev iptal edildi. İsterseniz yeniden sıraya alabilirsiniz.";
    default: return undefined;
  }
}

export function TaskDetail({ task, state, api, pending, act, onReview }: {
  task: TaskRecord;
  state: DesktopState;
  api: DesktopAPI;
  pending: boolean;
  act: (action: () => Promise<unknown>) => void;
  onReview: () => void;
}) {
  const { project, tasks } = state.snapshot;
  const hint = nextStep(task, state.busy);
  const waitsFor = task.dependsOn.map((id) => tasks.find((other) => other.id === id)?.title ?? id);

  return <section className="task-detail" aria-label="Seçili görev" style={laneStyle(state, task.agentId)}>
    <div className="detail-head">
      <span className={`status ${task.status}`}>{STATUS_LABEL[task.status]}</span>
      <span className="agent-token">{task.agentId}</span>
      {task.worktree && <code className="branch" title={task.worktree.path}>{task.worktree.branch}</code>}
    </div>
    <h3>{task.title}</h3>
    <code>{task.id}</code>

    {hint && <p className={`next-step ${task.status}`}>{hint}</p>}
    <div className="detail-actions">
      {task.worktree && task.status !== "running" && <button className={task.status === "pending_review" ? "primary" : ""} disabled={pending} onClick={onReview}>Değişiklikleri incele</button>}
      {["running", "pending"].includes(task.status) && <button disabled={pending} onClick={() => act(() => api.cancel(task.id))}>Görevi iptal et</button>}
      {["failed", "cancelled", "blocked", "needs_review"].includes(task.status) && <button disabled={state.busy || pending} onClick={() => act(() => api.retry(task.id))}>Yeniden sıraya al</button>}
    </div>

    {task.error && <pre className="task-error">{task.error}</pre>}
    {task.summary && <div className="result"><h4>Ajanın raporu</h4><p>{task.summary}</p></div>}

    <div className="instruction"><h4>Talimat</h4><p>{task.instruction}</p></div>
    <dl>
      <dt>Önce bitmesi gereken</dt><dd>{waitsFor.length ? waitsFor.join(", ") : "Yok, bağımsız"}</dd>
      <dt>Değiştirebileceği dosyalar</dt><dd><code>{task.allowedPaths.join("  ")}</code></dd>
    </dl>

    {!!task.tests?.length && <TestReports reports={task.tests} stale={!!task.review && task.testDigest !== task.review.digest} />}
    <ContextPackages key={JSON.stringify([project.id, project.workspaceRoot, task.id])} state={state} api={api} taskId={task.id} />
  </section>;
}
