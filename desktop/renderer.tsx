import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopAPI, DesktopReview, DesktopState } from "../src/desktop/contracts.js";
import { Activity } from "./activity.js";
import { AgentCenter } from "./agent-center.js";
import { PermissionPanel } from "./permission-panel.js";
import { ReviewDialog } from "./review-dialog.js";
import { TaskForm, TaskGraph } from "./task-board.js";
import { TaskDetail } from "./task-detail.js";
import { TaskRail } from "./task-rail.js";
import { TopBar } from "./top-bar.js";
import "./style.css";

const FileEditor = lazy(() => import("./editor.js").then((module) => ({ default: module.FileEditor })));
const TerminalPanel = lazy(() => import("./terminal.js").then((module) => ({ default: module.TerminalPanel })));

declare global { interface Window { agentmesh: DesktopAPI } }

function Onboarding({ state, onCreate, onOpenFolder, disabled }: {
  state: DesktopState; onCreate: () => void; onOpenFolder: () => void; disabled: boolean;
}) {
  return <section className="onboarding">
    <div className="eyebrow">Başlarken</div>
    <h1>İlk görevi ver, ajan ayrı bir dalda çalışsın.</h1>
    <ol className="steps">
      <li><b>Görev yaz</b><span>Ne yapılacağını ve kabul kriterlerini anlat. Birden fazla görev ve bağımlılık ekleyebilirsin.</span></li>
      <li><b>Ajanları başlat</b><span>Her görev kendi Git worktree'sinde çalışır; ana dalın değişmez.</span></li>
      <li><b>İncele ve onayla</b><span>Diff'i gör, onayla. Kod <code>{state.integrationBranch ?? "entegrasyon"}</code> dalında birikir.</span></li>
    </ol>
    <div className="onboarding-actions">
      <button className="primary" disabled={disabled} onClick={onCreate}>＋ İlk görevi oluştur</button>
      {state.demo && <button disabled={disabled} onClick={onOpenFolder}>Kendi projeni aç…</button>}
    </div>
  </section>;
}

function App() {
  const api = window.agentmesh;
  const [state, setState] = useState<DesktopState>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<"events" | "context" | "messages">("events");
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<DesktopReview>();
  const [editorDirty, setEditorDirty] = useState(false);
  const [mergeDirty, setMergeDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [agentCenter, setAgentCenter] = useState(false);

  useEffect(() => { document.documentElement.dataset.unsaved = String(editorDirty || mergeDirty); }, [editorDirty, mergeDirty]);
  useEffect(() => {
    let live = true;
    let received = false;
    const unsubscribe = api.subscribe((value) => { received = true; if (live) setState(value); });
    api.state().then((value) => { if (live && !received) setState(value); }).catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; unsubscribe(); };
  }, [api]);

  async function act(action: () => Promise<unknown>) {
    setError(""); setPending(true);
    try { await action(); setState(await api.state()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  }

  function canLeaveFile() {
    return !editorDirty || window.confirm("Kaydedilmemiş değişiklikler var. Yerel kurtarma kaydı mevcutsa dönüşte açılır. Yine de devam edilsin mi?");
  }

  if (!state) return <main className="loading"><b>AgentMesh</b><p>{error || "Çalışma alanı açılıyor…"}</p></main>;

  const { tasks, project } = state.snapshot;
  const contextPending = state.snapshot.contextConflicts.filter((conflict) => conflict.status === "pending").length;
  const task = tasks.find((item) => item.id === selected) ?? tasks[0];
  const ready = tasks.some((item) => item.status === "pending");
  const select = (id: string) => { if (id === task?.id || canLeaveFile()) setSelected(id); };
  const start = () => {
    if (editorDirty) setError("Başlatmadan önce dosya değişikliklerini kaydedin veya dosyayı yeniden açın.");
    else void act(() => api.start());
  };

  return <div className="app">
    <TopBar state={state} api={api} pending={pending} ready={ready} blocked={!!contextPending} guard={canLeaveFile}
      act={(action) => void act(action)} onAgents={() => setAgentCenter(true)} onStart={start} />

    <div className="layout">
      <TaskRail state={state} api={api} selected={task} pending={pending} onSelect={select}
        onCreate={() => setCreating(true)} act={(action) => void act(action)} />

      <main className="workbench">
        {error && <div role="alert" className="error"><span>{error}</span><button className="icon-button" aria-label="Hatayı kapat" onClick={() => setError("")}>×</button></div>}
        {state.demo && <div className="banner info">
          <p><b>Demo modu.</b> Ajanlar sahte; model çağrılmaz, dosya değişmez. Gerçek çalışma için bir Git deposu aç.</p>
          <button disabled={state.busy || pending} onClick={() => { if (canLeaveFile()) void act(() => api.openFolder()); }}>Klasör aç…</button>
        </div>}
        {state.uncommittedChanges && <div className="banner warn" role="status">
          <p><b>Depoda commit edilmemiş değişiklik var.</b> Ajanlar yalnızca son commit'i görür ve ilk çalıştırma temiz depo ister. Önce değişikliklerinizi commit edin.</p>
        </div>}
        {!!contextPending && <div className="banner warn context-alert" role="status">
          <p>{contextPending} ortak karar çakışıyor. Yeni görevler karar bekliyor.</p>
          <button onClick={() => setTab("context")}>Kararları incele</button>
        </div>}
        <PermissionPanel state={state} api={api} pending={pending} act={(action) => void act(action)} />

        {!task ? <Onboarding state={state} disabled={state.busy || pending} onCreate={() => setCreating(true)}
          onOpenFolder={() => { if (canLeaveFile()) void act(() => api.openFolder()); }} /> : <>
          {tasks.length > 1 && <details className="graph-panel">
            <summary>Görev akışı grafiği</summary>
            <TaskGraph tasks={tasks} selected={task.id} onSelect={select} />
          </details>}
          <TaskDetail task={task} state={state} api={api} pending={pending} act={(action) => void act(action)}
            onReview={() => void act(async () => setReview(await api.review(task.id)))} />
          <Suspense fallback={<p className="empty">Editör hazırlanıyor…</p>}>
            <FileEditor key={`${project.id}:${project.workspaceRoot}:${task.id}:${task.worktree?.path ?? "repo"}`} taskId={task.id}
              scope={JSON.stringify([project.id, project.workspaceRoot, task.id, task.worktree?.path ?? "repo"])}
              api={api} busy={state.busy} onDirty={setEditorDirty} />
          </Suspense>
          <Suspense fallback={<p className="empty">Terminal hazırlanıyor…</p>}>
            <TerminalPanel key={`${project.id}:${project.workspaceRoot}`} api={api} taskId={task.id} busy={state.busy}
              available={state.demo || !!task.worktree && !["running", "completed"].includes(task.status)} />
          </Suspense>
        </>}
      </main>

      <Activity state={state} api={api} taskId={task?.id} tab={tab} onTab={setTab} />
    </div>

    {review && <ReviewDialog review={review} api={api} integrationBranch={state.integrationBranch} onReview={setReview}
      onDirty={setMergeDirty} pending={pending} error={error}
      onClose={() => { setMergeDirty(false); setReview(undefined); }}
      onRefresh={() => void act(async () => setReview(await api.review(review.taskId, true)))}
      onApprove={() => void act(async () => {
        try { if (await api.approve(review.taskId, review.inspection.digest)) setReview(undefined); }
        catch (approveError) { setReview(await api.review(review.taskId)); throw approveError; }
      })} />}
    {creating && <TaskForm state={state} onClose={() => setCreating(false)}
      onCreate={async (draft) => { await api.createTask(draft); setState(await api.state()); setSelected(draft.id); }} />}
    {agentCenter && <AgentCenter state={state} api={api} onClose={() => setAgentCenter(false)} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
