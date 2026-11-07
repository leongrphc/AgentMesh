import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, DesktopReview } from "../src/desktop/contracts.js";
import { MergeResolution } from "./merge-resolution.js";
import { TestReports } from "./test-reports.js";

export function ReviewDialog({ review, api, integrationBranch, onReview, onDirty, onClose, onRefresh, onApprove, onRequestChanges, feedback, pending, error }: {
  review: DesktopReview;
  api: DesktopAPI;
  integrationBranch?: string;
  onReview: (review: DesktopReview) => void;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  onRefresh: () => void;
  onApprove: () => void;
  /** Sends the task back to its agent with written feedback. */
  onRequestChanges: (feedback: string) => void;
  /** The previous round's feedback, if this review answers one. */
  feedback?: { text: string; round: number };
  pending: boolean;
  error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false);
  const [comment, setComment] = useState("");
  const close = () => { if (!dirty || window.confirm("Kaydedilmemiş çakışma çözümü silinsin mi?")) onClose(); };
  useEffect(() => { dialog.current?.showModal(); }, []);
  const { inspection } = review;

  return <dialog className="review-dialog" ref={dialog} aria-labelledby="review-title"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="review-header">
      <div>
        <div className="eyebrow">Değişiklik incelemesi</div>
        <h2 id="review-title">{review.title}</h2>
      </div>
      <button className="icon-button" aria-label="İncelemeyi kapat" onClick={close}>×</button>
    </header>

    <div className="review-content">
      {error && <p className="task-error" role="alert">{error}</p>}
      <div className="review-summary">
        <div><span className="metric">{inspection.changedPaths.length}</span> dosya değişti</div>
        <p className="review-digest">SHA-256 <code>{inspection.digest}</code></p>
      </div>
      <TestReports reports={review.tests} stale={review.testsStale} />
      {!!inspection.violations.length && <p className="task-error">İzin verilen kapsam dışındaki dosyalar: {inspection.violations.join(", ")}</p>}
      {!review.canApprove && <p className="review-warning">
        Bu görünüm onaylanamaz. Görev durumu, dosya kapsamı, çözülmemiş çakışmalar veya beklenen değişiklikler farklı olabilir.
        Değişiklikleri kontrol edip incelemeyi yenileyin.
      </p>}
      <MergeResolution review={review} api={api} disabled={pending} onReview={onReview}
        onDirty={(value) => { setDirty(value); onDirty(value); }} />

      <h3>Değişen dosyalar · {inspection.changedPaths.length}</h3>
      <ul className="changed-files">{inspection.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      {inspection.trackedDiff && <>
        <h3>Takip edilen dosyalar</h3>
        <pre className="diff">{inspection.trackedDiff.split("\n").map((line, index) => <span key={index} className={diffClass(line)}>{line}{"\n"}</span>)}</pre>
      </>}
      {inspection.untrackedPreviews.map((file) => <section key={file.path}>
        <h3>Yeni dosya: {file.path}</h3>
        {file.truncated && <p className="review-warning">Önizleme kısaltıldı. Dosyanın tamamını çalışma alanında inceleyin.</p>}
        {file.binary && <p className="review-warning">İkili dosya; çalışma alanında ayrıca inceleyin.</p>}
        <pre className="diff">{file.preview}</pre>
      </section>)}
      <p className="review-note">
        Bu ekran test çalıştırmaz. Onaylanan kod önce{" "}
        {integrationBranch ? <code>{integrationBranch}</code> : "ayrı entegrasyon"} dalında toplanır;
        hazır olduğunuzda ana ekrandaki <b>Projeme uygula</b> ile klasörünüzdeki açık dala alınır.
      </p>
    </div>

    <div className="request-changes">
      {feedback && <p className="previous-feedback"><b>{feedback.round}. turdaki geri bildiriminiz:</b> {feedback.text}</p>}
      <label htmlFor="review-feedback">Değişiklik istemek için ajana ne yapması gerektiğini yazın</label>
      <textarea id="review-feedback" rows={3} maxLength={8000} value={comment} disabled={pending}
        placeholder="ör. Hata durumunu da ele al; fonksiyon negatif sayıda istisna fırlatsın." onChange={(event) => setComment(event.target.value)} />
    </div>
    <footer className="review-actions">
      <button disabled={pending || dirty || !comment.trim() || !!review.merge} onClick={() => onRequestChanges(comment.trim())}
        title="Görev aynı ajana, aynı çalışma alanında geri döner">Değişiklik iste</button>
      <span className="review-actions-spacer" />
      <button disabled={pending || dirty} onClick={onRefresh}>İncelemeyi yenile</button>
      <button className="primary" disabled={pending || dirty || !review.canApprove} onClick={onApprove}>Onayla ve birleştir</button>
    </footer>
  </dialog>;
}

function diffClass(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-file";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  if (line.startsWith("@@")) return "diff-hunk";
  return undefined;
}
