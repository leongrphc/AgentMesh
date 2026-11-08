import { useState } from "react";
import type { TaskRecord } from "../src/core/contracts.js";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import { ContextPackages } from "./context-packages.js";
import { laneStyle } from "./lanes.js";
import { formatCost, formatDuration, formatTokens } from "../src/desktop/event-text.js";
import { STATUS_LABEL } from "./task-rail.js";
import { TestReports } from "./test-reports.js";

const REASSIGNABLE = ["pending", "failed", "blocked", "needs_review", "cancelled"];

/** Hand a stopped task to another agent; it continues in the same worktree from where the last one stopped. */
function Handoff({ task, state, api, pending, act }: {
  task: TaskRecord; state: DesktopState; api: DesktopAPI; pending: boolean; act: (action: () => Promise<unknown>) => void;
}) {
  const others = state.agents.filter((agent) => agent.id !== task.agentId);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  if (!REASSIGNABLE.includes(task.status) || !others.length) return null;
  const chosen = others.some((agent) => agent.id === target) ? target : others[0]!.id;
  return <form className="handoff" onSubmit={(event) => { event.preventDefault(); act(() => api.reassign(task.id, chosen)); }}>
    <label>Başka ajana devret
      <select value={chosen} disabled={state.busy || pending} onChange={(event) => setTarget(event.target.value)}>
        {others.map((agent) => <option key={agent.id} value={agent.id} style={laneStyle(state, agent.id)}>{agent.id}</option>)}
      </select>
    </label>
    <button disabled={state.busy || pending}>Devret</button>
    <small>{task.worktree ? "Yeni ajan aynı çalışma alanında, öncekinin bıraktığı yerden devam eder." : "Görev henüz başlamadı; yalnızca ajanı değişir."}</small>
  </form>;
}

/** What the user should do next for a task, in one sentence. */
function nextStep(task: TaskRecord, busy: boolean): string | undefined {
  switch (task.status) {
    case "pending": return busy ? "Sırada. Önceki görevler bitince başlayacak." : "Hazır. Başlatmak için üstteki “Ajanları başlat” düğmesini kullanın.";
    case "running": return "Ajan çalışıyor. Neler yaptığını sağdaki akıştan izleyebilirsiniz.";
    case "pending_review": return "Ajan işini bitirdi. Değişiklikleri inceleyip onaylayın; bu göreve bağlı görevler onaydan sonra başlar.";
    case "failed": case "blocked": case "needs_review": return "Görev tamamlanamadı. Hatayı okuyun; yeniden sıraya alabilir ya da başka bir ajana devredebilirsiniz.";
    case "cancelled": return "Görev durduruldu. Yeniden sıraya alabilir ya da aşağıdan başka bir ajana devredebilirsiniz.";
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
    {task.usage && <p className="usage-line" title="Bu görevin tüm çalıştırmalarının toplamı">
      {formatDuration(task.usage.durationMs)} ajan süresi
      {task.usage.costUsd !== undefined && <> · {formatCost(task.usage.costUsd)}</>}
      {(task.usage.inputTokens || task.usage.outputTokens) ? <> · {formatTokens((task.usage.inputTokens ?? 0) + (task.usage.outputTokens ?? 0))} token</> : null}
      {task.usage.runs > 1 && <> · {task.usage.runs} çalıştırma</>}
    </p>}
    <code>{task.id}</code>

    {hint && <p className={`next-step ${task.status}`}>{hint}</p>}
    <div className="detail-actions">
      {task.worktree && task.status !== "running" && <button className={task.status === "pending_review" ? "primary" : ""} disabled={pending} onClick={onReview}>Değişiklikleri incele</button>}
      {["running", "pending"].includes(task.status) && <button disabled={pending} onClick={() => act(() => api.cancel(task.id))}>Görevi iptal et</button>}
      {["failed", "cancelled", "blocked", "needs_review"].includes(task.status) && <button disabled={state.busy || pending} onClick={() => act(() => api.retry(task.id))}>Yeniden sıraya al</button>}
    </div>
    <Handoff key={task.id} task={task} state={state} api={api} pending={pending} act={act} />
    {task.feedback && !task.feedback.addressed && <p className="handoff-note feedback-note"><b>Geri bildiriminiz ({task.feedback.round}. tur):</b> {task.feedback.text}</p>}
    {task.handoff && <p className="handoff-note">{task.handoff.from} ajanından devralındı · {new Date(task.handoff.at).toLocaleString("tr-TR")}</p>}

    {task.error && <pre className="task-error">{task.error}</pre>}
    {task.summary && <div className="result"><h4>Ajanın raporu</h4><p>{task.summary}</p></div>}

    <div className="instruction"><h4>Talimat</h4><p>{task.instruction}</p></div>
    <dl>
      <dt>Seçilen model</dt><dd>{task.model ?? state.agents.find((agent) => agent.id === task.agentId)?.model ?? "Sağlayıcı varsayılanı (model kimliği belirtilmedi)"}</dd>
      <dt>Önce bitmesi gereken</dt><dd>{waitsFor.length ? waitsFor.join(", ") : "Yok, bağımsız"}</dd>
      <dt>Değiştirebileceği dosyalar</dt><dd><code>{task.allowedPaths.join("  ")}</code></dd>
    </dl>

    {!!task.tests?.length && <TestReports reports={task.tests} stale={!!task.review && task.testDigest !== task.review.digest} />}
    <ContextPackages key={JSON.stringify([project.id, project.workspaceRoot, task.id])} state={state} api={api} taskId={task.id} />
  </section>;
}
