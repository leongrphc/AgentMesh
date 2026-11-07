import type { TaskRecord } from "../src/core/contracts.js";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import { ContextPackages } from "./context-packages.js";
import { STATUS_LABEL } from "./task-rail.js";
import { TestReports } from "./test-reports.js";

/** What the user should do next for a task, in one sentence. */
function nextStep(task: TaskRecord, busy: boolean): string | undefined {
  switch (task.status) {
    case "pending": return busy ? "Sırada; bağımlılıkları bitince başlayacak." : "Başlatmak için üstteki “Ajanları başlat” düğmesini kullanın.";
    case "running": return "Ajan çalışıyor. Canlı akışı sağdaki Etkinlik panelinden izleyin.";
    case "pending_review": return "Ajan işini bitirdi. Değişiklikleri inceleyip onaylayın; bağımlı görevler onaydan sonra başlar.";
    case "failed": case "blocked": case "needs_review": return "Hatayı inceleyin, gerekirse görevi yeniden kuyruğa alın.";
    case "cancelled": return "Görev iptal edildi. Yeniden kuyruğa alabilirsiniz.";
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
  const { project } = state.snapshot;
  const hint = nextStep(task, state.busy);
  return <section className="task-detail" aria-label="Seçili görev">
    <div className="detail-head">
      <span className={`status ${task.status}`}>{STATUS_LABEL[task.status]}</span>
      <span className="detail-agent">{task.agentId}</span>
    </div>
    <h3>{task.title}</h3>
    <code>{task.id}</code>
    {hint && <p className={`next-step ${task.status}`}>{hint}</p>}

    <div className="detail-actions">
      {task.worktree && task.status !== "running" && <button className={task.status === "pending_review" ? "primary" : ""} disabled={pending} onClick={onReview}>Değişiklikleri incele</button>}
      {["running", "pending"].includes(task.status) && <button disabled={pending} onClick={() => act(() => api.cancel(task.id))}>Görevi iptal et</button>}
      {["failed", "cancelled", "blocked", "needs_review"].includes(task.status) && <button disabled={state.busy || pending} onClick={() => act(() => api.retry(task.id))}>Yeniden kuyruğa al</button>}
    </div>

    {task.error && <p className="task-error">{task.error}</p>}
    {task.summary && <div className="result"><b>Ajanın sonucu</b><p>{task.summary}</p></div>}

    <div className="instruction"><b>Talimat</b><p>{task.instruction}</p></div>
    <dl>
      <dt>Ajan</dt><dd>{task.agentId}</dd>
      <dt>Önce bitmeli</dt><dd>{task.dependsOn.length ? task.dependsOn.join(", ") : "Yok"}</dd>
      <dt>Dosya kapsamı</dt><dd><code>{task.allowedPaths.join(", ")}</code></dd>
      {task.worktree && <><dt>Çalışma alanı</dt><dd><code title={task.worktree.path}>{task.worktree.branch}</code></dd></>}
    </dl>

    {!!task.tests?.length && <TestReports reports={task.tests} stale={!!task.review && task.testDigest !== task.review.digest} />}
    <ContextPackages key={JSON.stringify([project.id, project.workspaceRoot, task.id])} state={state} api={api} taskId={task.id} />
  </section>;
}
