import { useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import type { ContextChoice, ContextConflict, Fact } from "../src/core/contracts.js";

function Conflict({ conflict, current, api, busy }: { conflict: ContextConflict; current: Fact; api: DesktopAPI; busy: boolean }) {
  const [value, setValue] = useState(conflict.proposal.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function decide(choice: ContextChoice) {
    setSaving(true); setError("");
    try { await api.resolveContext(conflict.id, current.revision!, choice, choice === "custom" ? value : undefined); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  return <article className="context-conflict" data-context-conflict={conflict.id}>
    <h3><code>{conflict.key}</code> · Karar bekliyor</h3>
    <div className="context-choices">
      <section><b>Mevcut karar · sürüm {current.revision}</b><pre>{current.value}</pre><small>Kaynak: {current.sourceTaskId}</small></section>
      <section><b>Önerilen değişiklik</b><pre>{conflict.proposal.value}</pre><small>Kaynak: {conflict.proposal.sourceTaskId} · sürüm {conflict.baseRevision} ile karşılaştırıldı</small></section>
    </div>
    <div className="context-actions">
      <button disabled={busy || saving} onClick={() => void decide("keep")}>Mevcut kararı koru</button>
      <button disabled={busy || saving} onClick={() => void decide("accept")}>Öneriyi kabul et</button>
    </div>
    <details><summary>Farklı bir değerle çöz</summary><form onSubmit={(event) => { event.preventDefault(); void decide("custom"); }}>
      <label>Birleştirilmiş karar<textarea aria-label={`${conflict.key} kararı`} maxLength={16384} rows={4} value={value}
        disabled={busy || saving} onChange={(event) => setValue(event.target.value)} /></label>
      <button disabled={busy || saving || !value.trim()}>Düzenlenmiş kararı kaydet</button>
    </form></details>
    {error && <p className="file-error" role="alert">{error}</p>}
  </article>;
}

export function ContextPanel({ state, api }: { state: DesktopState; api: DesktopAPI }) {
  const { context, contextHistory, contextConflicts } = state.snapshot;
  const pending = contextConflicts.filter((conflict) => conflict.status === "pending");
  const resolved = contextConflicts.filter((conflict) => conflict.status === "resolved");
  return <div className="context-panel">
    {!!pending.length && <p role="status">{pending.length} context kararı bekliyor. Yeni görevler, kararlar çözüldükten sonra açıkça başlatılabilir.{state.busy ? " Karar vermek için çalışan görevlerin bitmesini bekleyin." : ""}</p>}
    {pending.map((conflict) => <Conflict key={conflict.id} conflict={conflict} current={context[conflict.key]!} api={api} busy={state.busy} />)}
    {Object.values(context).map((fact) => <article className="context-item" key={fact.key}>
      <code>{fact.key}</code><p>{fact.value}</p><small>Sürüm {fact.revision} · Kaynak: {fact.sourceTaskId}</small>
      <details><summary>Sürüm geçmişi · {contextHistory[fact.key]?.length ?? 0}</summary>
        <ol>{(contextHistory[fact.key] ?? []).map((version) => <li key={version.revision}>
          <b>Sürüm {version.revision}</b><p>{version.value}</p><small>{version.sourceTaskId} · {version.updatedAt}</small>
        </li>)}</ol>
      </details>
    </article>)}
    {!Object.keys(context).length && <p className="empty">Ajanların paylaştığı sonuçlar burada görünecek.</p>}
    {!!resolved.length && <details className="context-item"><summary>Çözülen kararlar · {resolved.length}</summary>
      {resolved.map((conflict) => <article key={conflict.id}>
        <p><code>{conflict.key}</code> · {conflict.resolution?.choice === "keep" ? "Mevcut karar korundu" : conflict.resolution?.choice === "custom" ? "Kullanıcının değeri kaydedildi" : "Öneri kabul edildi"} · sürüm {conflict.resolution?.revision}</p>
        <p>Öneri: {conflict.proposal.value}</p><small>Kaynak: {conflict.proposal.sourceTaskId} · {conflict.resolution?.at}</small>
      </article>)}
    </details>}
  </div>;
}
