import { useEffect, useState, type ReactNode } from "react";
import type { HistoryPage } from "../src/core/contracts.js";

export function PagedHistory<T>({ title, total, load, render, testId }: {
  title: string; total: number; load: (before?: number) => Promise<HistoryPage<T>>;
  render: (entries: T[]) => ReactNode; testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<number[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<HistoryPage<T>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const before = cursors.at(-1);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(""); setPage(undefined);
    void load(before).then(value => { if (!cancelled) setPage(value); },
      reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, before, refresh, load]);
  return <details data-testid={testId} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title} · {total}</summary>
    {loading && <p role="status">Geçmiş yükleniyor…</p>}
    {error && <p role="alert" className="file-error">{error}</p>}
    {page && <>{render(page.entries)}{!page.entries.length && <p>Bu aralıkta kayıt yok.</p>}
      {page.total !== total && <p>Yeni kayıtlar var. En yeni kayıtları açarak yenileyin.</p>}</>}
    <div className="context-actions">
      <button disabled={loading || !cursors.length} onClick={() => setCursors(previous => previous.slice(0, -1))}>Daha yeni</button>
      <button disabled={loading || !page?.nextBefore} onClick={() => { if (page?.nextBefore) setCursors(previous => [...previous, page.nextBefore!]); }}>Daha eski</button>
      <button disabled={loading} onClick={() => { setCursors([]); setRefresh(value => value + 1); }}>En yeni kayıtlar</button>
    </div>
  </details>;
}
