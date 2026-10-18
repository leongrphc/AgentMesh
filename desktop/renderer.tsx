import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopAPI, DesktopState, DesktopReview } from "../src/desktop/contracts.js";
import type { TaskStatus } from "../src/core/contracts.js";
import "./style.css";

declare global { interface Window { agentmesh: DesktopAPI } }

const labels: Record<TaskStatus, string> = { pending: "Sırada", running: "Çalışıyor", completed: "Tamamlandı",
  failed: "Başarısız", blocked: "Engellendi", pending_review: "İnceleme bekliyor", cancelled: "İptal edildi", needs_review: "Kontrol gerekli" };

function ReviewDialog({ review, onClose, onRefresh, onApprove, pending, error }: {
  review: DesktopReview; onClose: () => void; onRefresh: () => void; onApprove: () => void; pending: boolean; error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const { inspection } = review;
  return <dialog className="review-dialog" ref={dialog} onCancel={onClose} aria-labelledby="review-title">
    <div className="review-header"><div><div className="eyebrow">DEĞİŞİKLİK İNCELEMESİ</div><h2 id="review-title">{review.title}</h2></div><button aria-label="İncelemeyi kapat" onClick={onClose}>×</button></div>
    <div className="review-content">
      {error && <p className="task-error" role="alert">{error}</p>}
      <p className="review-digest">SHA-256 <code>{inspection.digest}</code></p>
      {!!inspection.violations.length && <p className="task-error">İzin dışı dosyalar: {inspection.violations.join(", ")}</p>}
      {!review.canApprove && <p className="review-warning">Bu görünüm onaylanamaz. Görev durumu, dosya kapsamı veya beklenen değişiklikler farklı olabilir. Değişiklikleri kontrol edip incelemeyi yenileyin. Commit edilmiş bir çakışma varsa görev branch’ini CLI üzerinden inceleyin.</p>}
      <h3>Değişen dosyalar · {inspection.changedPaths.length}</h3>
      <ul className="changed-files">{inspection.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      {inspection.trackedDiff && <><h3>Takip edilen dosyalar</h3><pre className="diff">{inspection.trackedDiff}</pre></>}
      {inspection.untrackedPreviews.map((file) => <section key={file.path}><h3>Yeni dosya: {file.path}</h3>{file.truncated && <p className="review-warning">Önizleme kısaltıldı. Dosyanın tamamını çalışma alanında inceleyin.</p>}{file.binary && <p className="review-warning">İkili dosya; çalışma alanında ayrıca inceleyin.</p>}<pre className="diff">{file.preview}</pre></section>)}
      <p className="review-warning">Test kanıtı görev sonucunda yer alır; bu ekran test çalıştırmaz. Onaylanan kod ayrı entegrasyon dalına birleştirilir.</p>
    </div>
    <div className="review-actions"><button disabled={pending} onClick={onRefresh}>İncelemeyi yenile</button><button className="primary" disabled={pending || !review.canApprove} onClick={onApprove}>Onayla ve birleştir</button></div>
  </dialog>;
}

function App() {
  const [state, setState] = useState<DesktopState>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<"events" | "context" | "messages">("events");
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<DesktopReview>();
  const api = window.agentmesh;

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
      <button className="side-button" disabled={state.busy || pending} onClick={() => act(() => api.openConfig())}>＋ Proje ayarlarını aç</button>
      <button className="side-button subtle" disabled={state.busy || pending} onClick={() => act(() => api.openDemo())}>Demo projesine dön</button>
      <div className="side-label agents-label">AJANLAR <span>{state.agents.length}</span></div>
      <div className="agent-list">{state.agents.map((agent) => {
        const working = tasks.find((item) => item.agentId === agent.id && item.status === "running");
        const done = tasks.filter((item) => item.agentId === agent.id).every((item) => item.status === "completed");
        return <div className="agent" key={agent.id}><span className={`agent-dot ${working ? "active" : done ? "done" : ""}`} />
          <div><strong>{agent.id}</strong><small>{state.demo ? "Mock · yerel demo" : `${agent.provider}${agent.model ? ` · ${agent.model}` : " · CLI"}`}</small></div>
          <span className="agent-state">{working ? "aktif" : done ? "bitti" : "hazır"}</span></div>;
      })}</div>
      <div className="sidebar-foot"><span className="local-dot" /> Yerel çalışma alanı<small>{state.demo ? "Demo model çağrısı yapmaz." : "Kodlar ayrı worktree’lerde işlenir."}</small></div>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumb">Çalışma alanı <span>/</span> <b>Orkestrasyon</b></div><span className="mode-tag">{state.demo ? "DEMO" : "CLI"}</span></header>
      <section className="workspace-heading"><div><div className="eyebrow">PROJE KONTROLÜ</div><h1>Birlikte çalışan ajanlar.</h1><p>Görevleri dağıt, ilerlemeyi izle, sonuçları incele.</p></div>
        <div className="run-actions"><button disabled={!state.busy || pending} onClick={() => act(() => api.cancel())}>Durdur</button><button className="primary" data-testid="start" disabled={state.busy || !ready || pending} onClick={() => act(() => api.start())}>{state.busy ? "Çalışıyor…" : "▶ Ajanları başlat"}</button></div>
      </section>
      {error && <div role="alert" className="error"><span>{error}</span><button aria-label="Hatayı kapat" onClick={() => setError("")}>×</button></div>}
      <div className="project-strip"><span className={`status-light ${state.busy ? "on" : ""}`} /><strong>{state.busy ? `${active} ajan çalışıyor` : "Çalışma alanı hazır"}</strong><span className="repo-path" title={project.workspaceRoot}>{project.workspaceRoot}</span><span>{completed} / {tasks.length} tamamlandı</span><progress value={completed} max={tasks.length || 1} aria-label="Tamamlanan görevler" /></div>
      <section className="task-section">
        <div className="section-heading"><h2>Görev akışı <span>{tasks.length}</span></h2><small>Bağımlılıklar tamamlanınca sıradaki görev başlar</small></div>
        <div className="task-layout"><div className="task-list">
          <div className="table-label"><span>GÖREV / AJAN</span><span>DURUM</span></div>
          {tasks.length === 0 && <p className="empty">Bu projede görev yok. Proje ayarlarına görev ekleyip yeniden açın.</p>}
          {tasks.map((item) => <button className={`task-row ${task?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelected(item.id)}>
            <span className={`task-symbol ${item.status}`}>{item.status === "completed" ? "✓" : item.status === "running" ? "◉" : "◇"}</span>
            <span className="task-title"><strong>{item.title}</strong><small>{item.agentId} <span>·</span> {item.dependsOn.length ? `Sonra: ${item.dependsOn.join(", ")}` : "Bağımsız görev"}</small></span>
            <span className={`status ${item.status}`}>{labels[item.status]}</span>
          </button>)}
        </div><aside className="task-detail">{task && <><div className="eyebrow">SEÇİLİ GÖREV</div><h3>{task.title}</h3><code>{task.id}</code><p>{task.instruction}</p>
          <dl><dt>Ajan</dt><dd>{task.agentId}</dd><dt>Durum</dt><dd>{labels[task.status]}</dd><dt>Dosya kapsamı</dt><dd>{task.allowedPaths.join(", ") || "Demo"}</dd></dl>
          {task.summary && <div className="result"><b>Sonuç</b><p>{task.summary}</p></div>}
          {task.error && <p className="task-error">{task.error}</p>}
          {task.status === "pending_review" && <p className="review-note">Bağımlı görevler değişiklikler onaylandıktan sonra başlayabilir.</p>}
          <div className="detail-actions">{["running", "pending"].includes(task.status) && <button disabled={pending} onClick={() => act(() => api.cancel(task.id))}>Görevi iptal et</button>}
          {task.worktree && task.status !== "running" && <button disabled={pending} onClick={() => act(async () => setReview(await api.review(task.id)))}>Değişiklikleri incele</button>}
          {["failed", "cancelled", "blocked", "needs_review"].includes(task.status) && <button disabled={state.busy || pending} onClick={() => act(() => api.retry(task.id))}>Yeniden kuyruğa al</button>}</div>
        </>}</aside></div>
      </section>
      <section className="activity"><div className="activity-header"><div role="tablist" aria-label="Proje kayıtları">{([
        ["events", "Canlı olaylar", state.events.length], ["context", "Ortak context", Object.keys(context).length], ["messages", "Mesajlar", messages.length],
      ] as const).map(([id, label, count]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} id={`tab-${id}`} onClick={() => setTab(id)}>{label} <span>{count}</span></button>)}</div><small><span className="local-dot" /> {state.busy ? "Canlı" : "Yerel kayıt"}</small></div>
        <div className="activity-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "events" && (state.events.length ? <div className="event-list">{[...state.events].reverse().map((event, index) => <div className="event" key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString("tr-TR")}</time><span className="event-task">{event.taskId ?? "proje"}</span><code>{event.text}</code></div>)}</div> : <div className="empty"><b>İlk göreve hazır.</b><p>Ajanları başlattığınızda olaylar burada görünecek.</p></div>)}
          {tab === "context" && (Object.keys(context).length ? Object.values(context).map((fact) => <article className="context-item" key={fact.key}><code>{fact.key}</code><p>{fact.value}</p><small>Kaynak: {fact.sourceTaskId}</small></article>) : <p className="empty">Ajanların paylaştığı sonuçlar burada görünecek.</p>)}
          {tab === "messages" && (messages.length ? messages.map((message) => <article className="context-item" key={message.id}><b>{message.from} → {message.to}</b><p>{message.body}</p><small>{message.kind} · {message.taskId}</small></article>) : <p className="empty">Ajanlar arası mesajlar burada görünecek.</p>)}
        </div>
      </section>
      <footer>AgentMesh <span>Görevler · ortak context · bağımsız çalışma alanları</span></footer>
    </main>
    {review && <ReviewDialog review={review} pending={pending} error={error} onClose={() => setReview(undefined)}
      onRefresh={() => act(async () => setReview(await api.review(review.taskId)))}
      onApprove={() => act(async () => { if (await api.approve(review.taskId, review.inspection.digest)) setReview(undefined); })} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
