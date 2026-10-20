import { useCallback } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import { PagedHistory } from "./paged-history.js";

export function ContextPackages({ state, api, taskId }: { state: DesktopState; api: DesktopAPI; taskId: string }) {
  const { id, workspaceRoot } = state.snapshot.project;
  const load = useCallback((before?: number) => api.contextPackages(id, workspaceRoot, taskId, before), [api, id, workspaceRoot, taskId]);
  const total = state.historyCounts.contextPackages[taskId] ?? 0;
  if (!total) return null;
  return <PagedHistory title="Hazırlanan context" total={total} load={load} testId="context-packages" render={entries => <>
    <p>Her denemede ajana gönderilmek üzere hazırlanan sürümler. Bu kayıt, modelin okuduğunu doğrulamaz.</p>
    {entries.map(entry => <details key={entry.executionId}><summary>{entry.entries.length} kayıt · {entry.bytes.toLocaleString("tr-TR")} bayt · {entry.executionId.slice(0, 8)}</summary>
      <p style={{ overflowWrap: "anywhere" }}>SHA-256: {entry.digest}</p>
      <ul>{entry.entries.map(fact => <li key={fact.key} style={{ overflowWrap: "anywhere" }}>{fact.key} · v{fact.revision}</li>)}</ul>
      {!entry.entries.length && <p>Boş context paketi.</p>}
    </details>)}
  </>} />;
}
