import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskForm, TaskGraph } from "./task-board.js";
import { AgentCenter } from "./agent-center.js";
import { TestReports } from "./test-reports.js";
import { MergeResolution } from "./merge-resolution.js";
import { Messages } from "./messages.js";
import type { DesktopAPI, DesktopState, DesktopReview } from "../src/desktop/contracts.js";
import type { TaskStatus } from "../src/core/contracts.js";
import "./style.css";

const FileEditor = lazy(() => import("./editor.js").then((module) => ({ default: module.FileEditor })));
const TerminalPanel = lazy(() => import("./terminal.js").then((module) => ({ default: module.TerminalPanel })));

declare global { interface Window { agentmesh: DesktopAPI } }

const labels: Record<TaskStatus, string> = { pending: "Sırada", running: "Çalışıyor", completed: "Tamamlandı",
  failed: "Başarısız", blocked: "Engellendi", pending_review: "İnceleme bekliyor", cancelled: "İptal edildi", needs_review: "Kontrol gerekli" };

function ReviewDialog({ review, api, onReview, onDirty, onClose, onRefresh, onApprove, pending, error }: {
  review: DesktopReview; api: DesktopAPI; onReview: (review: DesktopReview) => void; onDirty: (dirty: boolean) => void; onClose: () => void; onRefresh: () => void; onApprove: () => void; pending: boolean; error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false);
  const close = () => { if (!dirty || window.confirm("Kaydedilmemiş çakışma çözümü silinsin mi?")) onClose(); };
  useEffect(() => { dialog.current?.showModal(); }, []);
  const { inspection } = review;
  return <dialog className="review-dialog" ref={dialog} onCancel={(event) => { event.preventDefault(); close(); }} aria-labelledby="review-title">
    <div className="review-header"><div><div className="eyebrow">DEĞİŞİKLİK İNCELEMESİ</div><h2 id="review-title">{review.title}</h2></div><button aria-label="İncelemeyi kapat" onClick={close}>×</button></div>
    <div className="review-content">
      {error && <p className="task-error" role="alert">{error}</p>}
      <p className="review-digest">SHA-256 <code>{inspection.digest}</code></p>
      <TestReports reports={review.tests} stale={review.testsStale} />
      {!!inspection.violations.length && <p className="task-error">İzin dışı dosyalar: {inspection.violations.join(", ")}</p>}
      {!review.canApprove && <p className="review-warning">Bu görünüm onaylanamaz. Görev durumu, dosya kapsamı, çözülmemiş çakışmalar veya beklenen değişiklikler farklı olabilir. Değişiklikleri kontrol edip incelemeyi yenileyin.</p>}
      <MergeResolution review={review} api={api} disabled={pending} onReview={onReview} onDirty={(value) => { setDirty(value); onDirty(value); }} />
      <h3>Değişen dosyalar · {inspection.changedPaths.length}</h3>
      <ul className="changed-files">{inspection.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      {inspection.trackedDiff && <><h3>Takip edilen dosyalar</h3><pre className="diff">{inspection.trackedDiff}</pre></>}
      {inspection.untrackedPreviews.map((file) => <section key={file.path}><h3>Yeni dosya: {file.path}</h3>{file.truncated && <p className="review-warning">Önizleme kısaltıldı. Dosyanın tamamını çalışma alanında inceleyin.</p>}{file.binary && <p className="review-warning">İkili dosya; çalışma alanında ayrıca inceleyin.</p>}<pre className="diff">{file.preview}</pre></section>)}
      <p className="review-warning">Bu ekran test çalıştırmaz. Onaylanan kod ayrı entegrasyon dalına birleştirilir.</p>
    </div>
    <div className="review-actions"><button disabled={pending || dirty} onClick={onRefresh}>İncelemeyi yenile</button><button className="primary" disabled={pending || dirty || !review.canApprove} onClick={onApprove}>Onayla ve birleştir</button></div>
  </dialog>;
}

function App() {
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
  const [selectedOnly, setSelectedOnly] = useState(false);
  const api = window.agentmesh;
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
    return !editorDirty || window.confirm("Kaydedilmemiş dosya değişiklikleri silinsin mi?");
  }

  if (!state) return <main className="loading"><b>AgentMesh</b><p>{error || "Çalışma alanı açılıyor…"}</p></main>;
  const { tasks, context, messages, project } = state.snapshot;
  const task = tasks.find((item) => item.id === selected) ?? tasks[0];
  const completed = tasks.filter((item) => item.status === "completed").length;
  const active = tasks.filter((item) => item.status === "running").length;
  const ready = tasks.some((item) => item.status === "pending");

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">≋</span> AgentMesh<span className="version">LOCAL / 0.1</span></div>
      <div className="side-label">ÇALIŞMA ALANI</div>
      <div className="project-name"><span className="project-icon">⌘</span><div><strong>{project.id}</strong><small>{state.demo ? "Demo projesi" : "Yerel Git projesi"}</small></div></div>
      <button className="side-button" disabled={state.busy || pending} onClick={() => { if (canLeaveFile()) void act(() => api.openConfig()); }}>＋ Proje ayarlarını aç</button>
      <button className="side-button subtle" disabled={state.busy || pending} onClick={() => { if (canLeaveFile()) void act(() => api.openDemo()); }}>Demo projesine dön</button>
      <div className="side-label agents-label">AJANLAR <span>{state.agents.length}</span></div>
      <button className="side-button" data-testid="agent-center" onClick={() => setAgentCenter(true)}>Ajan merkezini aç</button>
      <div className="agent-list">{state.agents.map((agent) => {
        const working = tasks.find((item) => item.agentId === agent.id && item.status === "running");
        const done = tasks.filter((item) => item.agentId === agent.id).every((item) => item.status === "completed");
        return <div className="agent" key={agent.id}><span className={`agent-dot ${working ? "active" : done ? "done" : ""}`} />
          <div><strong>{agent.id}</strong><small>{state.demo ? "Mock · yerel demo" : `${agent.provider}${agent.model ? ` · ${agent.model}` : " · CLI"}`}</small></div>
          <span className="agent-state">{working ? state.permissions.some((request) => request.taskId === working.id) ? "izin bekliyor" : "aktif" : done ? "bitti" : "hazır"}</span></div>;
      })}</div>
      <div className="sidebar-foot"><span className="local-dot" /> Yerel çalışma alanı<small>{state.demo ? "Demo model çağrısı yapmaz." : "Kodlar ayrı worktree’lerde işlenir."}</small></div>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumb">Çalışma alanı <span>/</span> <b>Orkestrasyon</b></div><span className="mode-tag">{state.demo ? "DEMO" : "CLI"}</span></header>
      <section className="workspace-heading"><div><div className="eyebrow">PROJE KONTROLÜ</div><h1>Birlikte çalışan ajanlar.</h1><p>Görevleri dağıt, ilerlemeyi izle, sonuçları incele.</p></div>
        <div className="run-actions"><button disabled={!state.busy || pending} onClick={() => act(() => api.cancel())}>Durdur</button><button className="primary" data-testid="start" disabled={state.busy || !ready || pending} onClick={() => { if (editorDirty) setError("Başlatmadan önce dosya değişikliklerini kaydedin veya dosyayı yeniden açın."); else void act(() => api.start()); }}>{state.busy ? "Çalışıyor…" : "▶ Ajanları başlat"}</button></div>
      </section>
      {error && <div role="alert" className="error"><span>{error}</span><button aria-label="Hatayı kapat" onClick={() => setError("")}>×</button></div>}
      {!!state.permissions.length && <section className="permission-panel" aria-label="Bekleyen izinler"><h2>Ajan kararı bekliyor <span>{state.permissions.length}</span></h2>
        {state.permissions.map((request) => <article key={request.id}><div className="permission-title"><b>{request.taskId}</b><span>{request.provider} · {request.kind === "command" ? "Komut izni" : "Dosya izni"} · {new Date(request.expiresAt).toLocaleTimeString("tr-TR")} tarihine kadar</span></div>
          <pre>{request.description}</pre><div className="permission-actions"><small>Hassas değerler maskelenmiş olabilir. Karar yalnızca bu istek için geçerlidir.</small><button disabled={pending} onClick={() => act(() => api.decidePermission(request.id, request.executionId, request.digest, "deny"))}>Reddet</button><button className="primary" disabled={pending} onClick={() => act(() => api.decidePermission(request.id, request.executionId, request.digest, "allow_once"))}>Bir kez izin ver</button></div>
        </article>)}</section>}
      <div className="project-strip"><span className={`status-light ${state.busy ? "on" : ""}`} /><strong>{state.busy ? `${active} ajan çalışıyor` : "Çalışma alanı hazır"}</strong><span className="repo-path" title={project.workspaceRoot}>{project.workspaceRoot}</span><span>{completed} / {tasks.length} tamamlandı</span><progress value={completed} max={tasks.length || 1} aria-label="Tamamlanan görevler" /></div>
      <section className="task-section">
        <div className="section-heading"><h2>Görev akışı <span>{tasks.length}</span></h2><div className="board-controls"><label>Paralel ajan <select aria-label="Paralel ajan sayısı" value={state.maxParallel} disabled={state.busy || pending} onChange={(event) => act(() => api.setParallelism(Number(event.target.value)))}>{Array.from({ length: 8 }, (_, i) => <option value={i + 1} key={i + 1}>{i + 1}</option>)}</select></label><button data-testid="create-task" disabled={state.busy || pending} onClick={() => setCreating(true)}>＋ Görev ekle</button></div></div>
        <TaskGraph tasks={tasks} selected={task?.id} onSelect={(id) => { if (id === task?.id || canLeaveFile()) setSelected(id); }} />
        <div className="task-layout"><div className="task-list">
          <div className="table-label"><span>GÖREV / AJAN</span><span>DURUM</span></div>
          {tasks.length === 0 && <p className="empty">Bu projede görev yok. Proje ayarlarına görev ekleyip yeniden açın.</p>}
          {tasks.map((item) => <button className={`task-row ${task?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => { if (item.id === task?.id || canLeaveFile()) setSelected(item.id); }}>
            <span className={`task-symbol ${item.status}`}>{item.status === "completed" ? "✓" : item.status === "running" ? "◉" : "◇"}</span>
            <span className="task-title"><strong>{item.title}</strong><small>{item.agentId} <span>·</span> {item.dependsOn.length ? `Sonra: ${item.dependsOn.join(", ")}` : "Bağımsız görev"}</small></span>
            <span className={`status ${item.status}`}>{state.permissions.some((request) => request.taskId === item.id) ? "İzin bekliyor" : labels[item.status]}</span>
          </button>)}
        </div><aside className="task-detail">{task && <><div className="eyebrow">SEÇİLİ GÖREV</div><h3>{task.title}</h3><code>{task.id}</code><p>{task.instruction}</p>
          <dl><dt>Ajan</dt><dd>{task.agentId}</dd><dt>Durum</dt><dd>{labels[task.status]}</dd><dt>Dosya kapsamı</dt><dd>{task.allowedPaths.join(", ") || "Demo"}</dd></dl>
          {task.summary && <div className="result"><b>Sonuç</b><p>{task.summary}</p></div>}
          {!!task.tests?.length && <TestReports reports={task.tests} stale={!!task.review && task.testDigest !== task.review.digest} />}
          {task.error && <p className="task-error">{task.error}</p>}
          {task.status === "pending_review" && <p className="review-note">Bağımlı görevler değişiklikler onaylandıktan sonra başlayabilir.</p>}
          <div className="detail-actions">{["running", "pending"].includes(task.status) && <button disabled={pending} onClick={() => act(() => api.cancel(task.id))}>Görevi iptal et</button>}
          {task.worktree && task.status !== "running" && <button disabled={pending} onClick={() => act(async () => setReview(await api.review(task.id)))}>Değişiklikleri incele</button>}
          {["failed", "cancelled", "blocked", "needs_review"].includes(task.status) && <button disabled={state.busy || pending} onClick={() => act(() => api.retry(task.id))}>Yeniden kuyruğa al</button>}</div>
        </>}</aside></div>
      </section>
      {task && <Suspense fallback={<p className="empty">Editör hazırlanıyor…</p>}><FileEditor key={`${project.id}:${project.workspaceRoot}:${task.id}:${task.worktree?.path ?? "repo"}`} taskId={task.id} api={api} busy={state.busy} onDirty={setEditorDirty} /></Suspense>}
      <Suspense fallback={<p className="empty">Terminal hazırlanıyor…</p>}><TerminalPanel key={`${project.id}:${project.workspaceRoot}`} api={api} taskId={task?.id} busy={state.busy}
        available={state.demo || !!task?.worktree && !["running", "completed"].includes(task.status)} /></Suspense>
      <section className="activity"><div className="activity-header"><div role="tablist" aria-label="Proje kayıtları">{([
        ["events", "Canlı olaylar", state.events.length], ["context", "Ortak context", Object.keys(context).length], ["messages", "Mesajlar", messages.length],
      ] as const).map(([id, label, count]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} id={`tab-${id}`} onClick={() => setTab(id)}>{label} <span>{count}</span></button>)}</div><label className="history-filter"><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />Seçili görev</label><small><span className="local-dot" /> {state.busy ? "Canlı" : "Son 200 olay"}</small></div>
        <div className="activity-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "events" && (state.events.length ? <div className="event-list">{[...state.events].reverse().filter((event) => !selectedOnly || event.taskId === task?.id).map((event, index) => <div className="event" key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString("tr-TR")}</time><span className="event-task">{event.taskId ?? "proje"}</span><code>{event.text}</code></div>)}</div> : <div className="empty"><b>İlk göreve hazır.</b><p>Ajanları başlattığınızda olaylar burada görünecek.</p></div>)}
          {tab === "context" && (Object.keys(context).length ? Object.values(context).map((fact) => <article className="context-item" key={fact.key}><code>{fact.key}</code><p>{fact.value}</p><small>Kaynak: {fact.sourceTaskId}</small></article>) : <p className="empty">Ajanların paylaştığı sonuçlar burada görünecek.</p>)}
          {tab === "messages" && <Messages key={project.id + project.workspaceRoot} state={state} api={api} taskId={task?.id} selectedOnly={selectedOnly} />}
        </div>
      </section>
      <footer>AgentMesh <span>Görevler · ortak context · bağımsız çalışma alanları</span></footer>
    </main>
    {review && <ReviewDialog review={review} api={api} onReview={setReview} onDirty={setMergeDirty} pending={pending} error={error} onClose={() => { setMergeDirty(false); setReview(undefined); }}
      onRefresh={() => act(async () => setReview(await api.review(review.taskId, true)))}
      onApprove={() => act(async () => {
        try { if (await api.approve(review.taskId, review.inspection.digest)) setReview(undefined); }
        catch (error) { setReview(await api.review(review.taskId)); throw error; }
      })} />}
    {creating && <TaskForm state={state} onClose={() => setCreating(false)} onCreate={async (draft) => { await api.createTask(draft); setState(await api.state()); }} />}
    {agentCenter && <AgentCenter state={state} api={api} onClose={() => setAgentCenter(false)} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
