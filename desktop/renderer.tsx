import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { DesktopAPI, DesktopReview, DesktopState } from "../src/desktop/contracts.js";
import { Activity } from "./activity.js";
import { ActivityBar, StatusBar } from "./ide-chrome.js";
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

/** Panel layout is a per-viewer convenience; storage may be unavailable, so every access is guarded. */
const LAYOUT_KEY = "agentmesh.layout";
function readLayout<T>(key: string, fallback: T): T {
  try {
    const value = (JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<string, unknown>)[key];
    return typeof value === typeof fallback ? value as T : fallback;
  } catch { return fallback; }
}
function writeLayout(value: Record<string, unknown>) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(value)); } catch { /* Layout simply resets next time. */ }
}

function Onboarding({ state, onCreate, onOpenFolder, disabled }: {
  state: DesktopState; onCreate: () => void; onOpenFolder: () => void; disabled: boolean;
}) {
  const folder = state.demo ? "projenizin" : state.snapshot.project.workspaceRoot.split(/[\\/]/).pop();
  return <section className="onboarding">
    <h1>Ajanlara iş verin, siz yönetin.</h1>
    <p className="lede">Her görev {folder} klasöründeki <code>.agentmesh/</code> altında, kendi dalında çalışır. Siz onaylamadan dosyalarınız değişmez.</p>
    <ol className="route">
      <li><b>Görevi yazın</b><span>Ne yapılacağını ve işin ne zaman bitmiş sayılacağını anlatın. Birbirine bağlı birden fazla görev ekleyebilirsiniz.</span></li>
      <li><b>Ajanları başlatın</b><span>Bağımsız görevler farklı ajanlarda aynı anda çalışır; bağlı olanlar sırasını bekler.</span></li>
      <li><b>İnceleyin ve uygulayın</b><span>Değişiklikleri satır satır görün, onaylayın, sonra <b>Projeme uygula</b> ile kendi dalınıza alın.</span></li>
    </ol>
    <div className="onboarding-actions">
      <button className="primary" disabled={disabled} onClick={onCreate}>İlk görevi yaz</button>
      {state.demo && <button disabled={disabled} onClick={onOpenFolder}>Kendi projenizi açın…</button>}
    </div>
  </section>;
}

function App() {
  const api = window.agentmesh;
  const [state, setState] = useState<DesktopState>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<"events" | "context" | "messages">("events");
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<DesktopReview>();
  const [editorDirty, setEditorDirty] = useState(false);
  const [mergeDirty, setMergeDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [agentCenter, setAgentCenter] = useState(false);
  const [sidebar, setSidebar] = useState(() => readLayout("sidebar", true));
  const [panel, setPanel] = useState(() => readLayout("panel", true));
  const [panelHeight, setPanelHeight] = useState(() => readLayout("panelHeight", 280));
  useEffect(() => { writeLayout({ sidebar, panel, panelHeight }); }, [sidebar, panel, panelHeight]);

  // IDE shortcuts: Ctrl+B toggles the task sidebar, Ctrl+J the terminal/activity panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === "b") { event.preventDefault(); setSidebar((value) => !value); }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); setPanel((value) => !value); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const resizePanel = (height: number) => setPanelHeight(Math.round(Math.min(Math.max(height, 140), window.innerHeight * 0.7)));
  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY, startHeight = panelHeight;
    const move = (moveEvent: PointerEvent) => resizePanel(startHeight + startY - moveEvent.clientY);
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); document.body.classList.remove("resizing"); };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

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

  const banners = <>
    {error && <div role="alert" className="error"><span>{error}</span><button className="icon-button" aria-label="Hatayı kapat" onClick={() => setError("")}>×</button></div>}
    {state.demo && <div className="banner info">
      <p><b>Demo modu.</b> Ajanlar sahte; model çağrılmaz, dosya değişmez.</p>
      <button disabled={state.busy || pending} onClick={() => { if (canLeaveFile()) void act(() => api.openFolder()); }}>Klasör aç…</button>
    </div>}
    {state.uncommittedChanges && <div className="banner warn" role="status">
      <p><b>Commit edilmemiş değişiklik var.</b> Ajanlar yalnızca son commit'i görür; ilk çalıştırma temiz depo ister.</p>
    </div>}
    {!!contextPending && <div className="banner warn context-alert" role="status">
      <p>{contextPending} ortak karar çakışıyor. Yeni görevler karar bekliyor.</p>
      <button onClick={() => { setPanel(true); setTab("context"); }}>Kararları incele</button>
    </div>}
    {!state.busy && tasks.some((item) => item.status === "completed") && tasks.some((item) => item.status === "pending"
      && item.dependsOn.every((id) => tasks.find((other) => other.id === id)?.status === "completed")) && <div className="banner info" role="status">
      <p><b>Sıradaki görevler hazır.</b> Onayladığınız işlere bağlı görevler başlayabilir.</p>
      <button className="primary" disabled={pending || !!contextPending} onClick={start}>▶ Devam et</button>
    </div>}
    {!state.demo && state.integrationPending > 0 && <div className="banner ok" role="status">
      <p><b>{state.integrationPending} onaylı değişiklik uygulanmayı bekliyor.</b> Klasörünüzdeki dosyalar henüz değişmedi.</p>
      <button className="primary" disabled={state.busy || pending} onClick={() => void act(async () => {
        const result = await api.applyIntegration();
        if (result) setNotice(`${result.commits} onaylı commit "${result.branch}" dalına ${result.fastForward ? "eklendi" : "birleştirildi"}. Dosyalar klasörünüzde.`);
      })}>Projeme uygula</button>
    </div>}
    {state.openNotice && <div className="banner info" role="status"><p>{state.openNotice}</p></div>}
    {notice && <div className="banner ok" role="status"><p>{notice}</p><button className="icon-button" aria-label="Bildirimi kapat" onClick={() => setNotice("")}>×</button></div>}
    <PermissionPanel state={state} api={api} pending={pending} act={(action) => void act(action)} />
  </>;

  return <div className="app" style={{ "--panel-h": `${panel ? panelHeight : 0}px` } as CSSProperties}>
    <TopBar state={state} api={api} pending={pending} ready={ready} blocked={!!contextPending} guard={canLeaveFile}
      act={(action) => void act(action)} onStart={start} />

    <div className={`layout ${sidebar ? "" : "no-sidebar"}`}>
      <ActivityBar sidebar={sidebar} panel={panel} onSidebar={() => setSidebar((value) => !value)} onPanel={() => setPanel((value) => !value)}
        onAgents={() => setAgentCenter(true)} agentsNeedAttention={!state.demo && state.agents.some((agent) => !state.health[agent.id])} />
      <TaskRail state={state} api={api} selected={task} pending={pending} onSelect={select}
        onCreate={() => setCreating(true)} act={(action) => void act(action)} />

      <div className={`main-area ${panel ? "" : "panel-closed"}`}>
        <div className="work-row">
          <main className="editor-area" aria-label="Kod">
            {!task ? <Onboarding state={state} disabled={state.busy || pending} onCreate={() => setCreating(true)}
              onOpenFolder={() => { if (canLeaveFile()) void act(() => api.openFolder()); }} />
              : <Suspense fallback={<p className="empty">Editör hazırlanıyor…</p>}>
                <FileEditor key={`${project.id}:${project.workspaceRoot}:${task.id}:${task.worktree?.path ?? "repo"}`} taskId={task.id}
                  scope={JSON.stringify([project.id, project.workspaceRoot, task.id, task.worktree?.path ?? "repo"])}
                  api={api} busy={state.busy} onDirty={setEditorDirty} />
              </Suspense>}
          </main>
          <aside className="inspector" aria-label="Görev denetçisi">
            {banners}
            {task ? <TaskDetail task={task} state={state} api={api} pending={pending} act={(action) => void act(action)}
              onReview={() => void act(async () => setReview(await api.review(task.id)))} />
              : <div className="inspector-empty"><b>Görev seçilmedi</b><p>Soldaki listeden bir görev seçin ya da yeni görev yazın.</p></div>}
            {tasks.length > 1 && <details className="graph-panel">
              <summary>Bağımlılık grafiği</summary>
              <TaskGraph tasks={tasks} selected={task?.id} onSelect={select} />
            </details>}
          </aside>
        </div>

        <div className="panel-resizer" role="separator" aria-orientation="horizontal" aria-label="Alt paneli yeniden boyutlandır"
          aria-valuenow={panelHeight} tabIndex={0} onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); resizePanel(panelHeight + 24); }
            if (event.key === "ArrowDown") { event.preventDefault(); resizePanel(panelHeight - 24); }
          }} />

        <section className="bottom-panel" aria-label="Terminal ve akış">
          <Suspense fallback={<p className="empty">Terminal hazırlanıyor…</p>}>
            <TerminalPanel key={`${project.id}:${project.workspaceRoot}`} api={api} taskId={task?.id} busy={state.busy}
              available={state.demo || !!task?.worktree && !["running", "completed"].includes(task.status)} />
          </Suspense>
          <Activity state={state} api={api} taskId={task?.id} tab={tab} onTab={setTab} />
        </section>
      </div>
    </div>

    <StatusBar state={state} />

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
