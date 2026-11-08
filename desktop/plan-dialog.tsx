import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, DesktopState, TaskDraft } from "../src/desktop/contracts.js";
import { laneStyle } from "./lanes.js";

/**
 * Goal → plan → tasks. An agent drafts the tasks; nothing is created until the user has
 * reviewed (and possibly edited or trimmed) the plan and pressed "Görevleri ekle".
 */
export function PlanDialog({ state, api, onClose, onCreated }: {
  state: DesktopState; api: DesktopAPI; onClose: () => void; onCreated: (firstTaskId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [goal, setGoal] = useState("");
  const [planner, setPlanner] = useState(state.agents[0]?.id ?? "");
  const [drafts, setDrafts] = useState<TaskDraft[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function plan() {
    setBusy(true); setError("");
    try { setDrafts(await api.planTasks(goal.trim(), planner)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!drafts?.length) return;
    setBusy(true); setError("");
    const ids = new Set(drafts.map((draft) => draft.id));
    const existing = new Set(state.snapshot.tasks.map((task) => task.id));
    try {
      // Drafts arrive dependencies-first; dependencies on removed drafts are dropped.
      for (const draft of drafts) await api.createTask({ ...draft, dependsOn: draft.dependsOn.filter((id) => ids.has(id) || existing.has(id)) });
      onCreated(drafts[0]!.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const update = (index: number, change: Partial<TaskDraft>) => setDrafts((list) => list?.map((draft, i) => i === index ? { ...draft, ...change } : draft));
  const titleOf = (id: string) => drafts?.find((draft) => draft.id === id)?.title ?? state.snapshot.tasks.find((task) => task.id === id)?.title ?? id;

  return <dialog className="review-dialog plan-dialog" ref={dialog} aria-labelledby="plan-title"
    onCancel={(event) => { event.preventDefault(); if (busy) void api.cancelPlan(); else onClose(); }}>
    <header className="review-header">
      <div><div className="eyebrow">Planla</div><h2 id="plan-title">{drafts ? `${drafts.length} görevlik plan` : "Hedefi yazın, ajan görevlere bölsün"}</h2></div>
      <button className="icon-button" aria-label="Plan penceresini kapat" disabled={busy} onClick={onClose}>×</button>
    </header>
    <div className="review-content">
      {error && <p className="file-error" role="alert">{error}</p>}
      {!drafts ? <>
        <label className="plan-goal">Hedef
          <textarea rows={5} maxLength={4000} autoFocus value={goal} disabled={busy} onChange={(event) => setGoal(event.target.value)}
            placeholder="ör. Ürün sayfasına yorum ve puanlama sistemi ekle: API, veritabanı tablosu, arayüz ve testler." />
        </label>
        <label className="plan-goal">Planlayıcı ajan
          <select value={planner} disabled={busy} onChange={(event) => setPlanner(event.target.value)}>
            {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
          </select>
        </label>
        <p className="form-help">Planlayıcı yalnızca okur: proje dosyalarının listesini ve README'yi görür, hiçbir dosyayı değiştirmez. Plan size gösterilmeden görev oluşturulmaz.</p>
      </> : <ol className="plan-list">
        {drafts.map((draft, index) => <li key={draft.id} style={laneStyle(state, draft.agentId)}>
          <div className="plan-row">
            <input aria-label="Görev başlığı" value={draft.title} maxLength={200} disabled={busy} onChange={(event) => update(index, { title: event.target.value })} />
            <select aria-label="Ajan" value={draft.agentId} disabled={busy} onChange={(event) => update(index, { agentId: event.target.value, model: undefined })}>
              {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
            </select>
            <button type="button" className="icon-button" aria-label={`${draft.title} görevini plandan çıkar`} disabled={busy}
              onClick={() => setDrafts((list) => list?.filter((_, i) => i !== index))}>×</button>
          </div>
          <label>Görev modeli (isteğe bağlı)<input aria-label={`${draft.title} görev modeli`} maxLength={200} disabled={busy}
            value={draft.model ?? ""} placeholder={state.agents.find((agent) => agent.id === draft.agentId)?.model ?? "Sağlayıcı varsayılanı"}
            onChange={(event) => update(index, { model: event.target.value.trim() || undefined })} /></label>
          <textarea aria-label="Talimat" rows={3} maxLength={16000} value={draft.instruction} disabled={busy} onChange={(event) => update(index, { instruction: event.target.value })} />
          <small>{draft.dependsOn.length ? `Önce: ${draft.dependsOn.map(titleOf).join(", ")}` : "Bağımsız; diğerleriyle aynı anda çalışabilir"} · Dosyalar: <code>{draft.allowedPaths.join(" ")}</code></small>
        </li>)}
      </ol>}
    </div>
    <footer className="review-actions">
      {drafts && <button type="button" disabled={busy} onClick={() => setDrafts(undefined)}>Hedefi değiştir</button>}
      <span className="review-actions-spacer" />
      {busy && !drafts && <button type="button" onClick={() => void api.cancelPlan()}>İptal</button>}
      {!drafts
        ? <button className="primary" data-testid="make-plan" disabled={busy || !goal.trim() || !planner} onClick={() => void plan()}>{busy ? "Plan hazırlanıyor…" : "Plan oluştur"}</button>
        : <button className="primary" data-testid="add-plan" disabled={busy || !drafts.length} onClick={() => void create()}>{busy ? "Ekleniyor…" : `Görevleri ekle (${drafts.length})`}</button>}
    </footer>
  </dialog>;
}
