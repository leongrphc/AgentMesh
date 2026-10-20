import { useState } from "react";
import type { DesktopAPI, DesktopReview } from "../src/desktop/contracts.js";
import type { ConflictFile } from "../src/core/workspace-files.js";

export function MergeResolution({ review, api, disabled, onReview, onDirty }: {
  review: DesktopReview; api: DesktopAPI; disabled: boolean;
  onReview: (review: DesktopReview) => void; onDirty: (dirty: boolean) => void;
}) {
  const [file, setFile] = useState<ConflictFile>();
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const merge = review.merge;
  if (!merge) return null;
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  const blocked = disabled || busy;
  return <section className="merge-resolution" aria-label="Birleştirme çakışması">
    <h3>Birleştirme çakışması</h3>
    <p>Çözüm görev worktree’sinde hazırlanır. Entegrasyon dalı ancak çözümü inceleyip yeniden onayladığınızda değişir.</p>
    {error && <p className="file-error" role="alert">{error}</p>}
    {!merge.active ? <>
      <p>Çakışan dosyalar: {merge.paths.join(", ")}</p>
      <button disabled={blocked || dirty} onClick={() => void run(async () =>
        onReview(await api.prepareMergeResolution(review.taskId, review.inspection.digest, merge.integrationCommit))
      )}>Çözümü görev alanında aç</button>
    </> : <>
      <p>{merge.unresolved.length ? `${merge.unresolved.length} dosya çözüm bekliyor. HEAD tarafı görevin, diğer taraf entegrasyonun sürümüdür.` : "Dosya çakışmaları çözüldü. Aşağıdaki diff'i inceleyip onaylayın."}</p>
      <ul className="merge-file-list">{merge.unresolved.map((path) => <li key={path}>
        <button disabled={blocked} onClick={() => void run(async () => {
          if (dirty && !window.confirm("Kaydedilmemiş çakışma çözümü silinsin mi?")) return;
          const next = await api.conflictFile(review.taskId, path);
          setFile(next); setContent(next.content ?? ""); setDirty(false); onDirty(false);
        })}>{path}</button>
      </li>)}</ul>
      {file && merge.unresolved.includes(file.path) && <form onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const next = await api.resolveConflict(review.taskId, file.path, content, file.digest);
          setFile(undefined); setDirty(false); onDirty(false); onReview(next);
        });
      }}>
        {file.binary ? <p>İkili veya UTF-8 olmayan dosya. Metin düzenlemesi kapalı; mevcut sürümü koruyabilir veya dosyayı silebilirsiniz.</p>
          : <label>Çözüm · {file.path}<textarea aria-label="Çakışma çözümü" rows={14} value={content} disabled={blocked} spellCheck={false}
            onChange={(event) => { setContent(event.target.value); setDirty(true); onDirty(true); }} /></label>}
        <div className="merge-actions">
          {!file.binary && <button className="primary" type="submit" disabled={blocked}>Kaydet ve çözüldü işaretle</button>}
          {file.binary && <button type="button" disabled={blocked} onClick={() => void run(async () => {
            const next = await api.resolveConflict(review.taskId, file.path, null, file.digest, true);
            setFile(undefined); setDirty(false); onDirty(false); onReview(next);
          })}>Mevcut dosyayı koru</button>}
          <button type="button" disabled={blocked} onClick={() => void run(async () => {
            if (!window.confirm(`${file.path} silinerek çakışma çözülsün mü?`)) return;
            const next = await api.resolveConflict(review.taskId, file.path, null, file.digest);
            setFile(undefined); setDirty(false); onDirty(false); onReview(next);
          })}>Dosyayı silerek çöz</button>
        </div>
      </form>}
    </>}
  </section>;
}
