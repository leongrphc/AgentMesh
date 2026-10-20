import { useEffect, useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import type { ContextChoice, ContextConflict, Fact, ContextHistoryPage } from "../src/core/contracts.js";

function History({ fact, state, api }: { fact: Fact; state: DesktopState; api: DesktopAPI }) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<number[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<ContextHistoryPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const before = cursors.at(-1);
  const { id, workspaceRoot } = state.snapshot.project;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(""); setPage(undefined);
    void api.contextHistory(id, workspaceRoot, fact.key, before).then(result => {
      if (!cancelled) setPage(result);
    }, reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, id, workspaceRoot, fact.key, before, refresh, api]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Sürüm geçmişi · {fact.revision ?? 0}</summary>
    {loading && <p role="status">Sürümler yükleniyor…</p>}
    {error && <p role="alert" className="file-error">{error}</p>}
    {page && <><ol>{page.entries.map(version => <li key={version.revision}><b>Sürüm {version.revision}</b><p>{version.value}</p><small>{version.sourceTaskId} · {version.updatedAt}</small></li>)}</ol>
      {!page.entries.length && <p>Bu aralıkta sürüm yok.</p>}
      {page.latestRevision !== fact.revision && <p>Yeni sürümler var. En yeni sürümleri açarak yenileyin.</p>}</>}
    <div className="context-actions">
      <button disabled={loading || !cursors.length} onClick={() => setCursors(previous => previous.slice(0, -1))}>Daha yeni</button>
      <button disabled={loading || !page?.nextBefore} onClick={() => { if (page?.nextBefore) setCursors(previous => [...previous, page.nextBefore!]); }}>Daha eski</button>
      <button disabled={loading} onClick={() => { setCursors([]); setRefresh(value => value + 1); }}>En yeni sürümler</button>
    </div>
  </details>;
}

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
  const { context, contextConflicts } = state.snapshot;
  const pending = contextConflicts.filter((conflict) => conflict.status === "pending");
  const resolved = contextConflicts.filter((conflict) => conflict.status === "resolved");
  return <div className="context-panel">
    {!!pending.length && <p role="status">{pending.length} context kararı bekliyor. Yeni görevler, kararlar çözüldükten sonra açıkça başlatılabilir.{state.busy ? " Karar vermek için çalışan görevlerin bitmesini bekleyin." : ""}</p>}
    {pending.map((conflict) => <Conflict key={conflict.id} conflict={conflict} current={context[conflict.key]!} api={api} busy={state.busy} />)}
    {Object.values(context).map((fact) => <article className="context-item" key={fact.key}>
      <code>{fact.key}</code><p>{fact.value}</p><small>Sürüm {fact.revision} · Kaynak: {fact.sourceTaskId}</small>
      <History fact={fact} state={state} api={api} />
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
