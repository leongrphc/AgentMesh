import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../src/desktop/contracts.js";

type Versions = Awaited<ReturnType<DesktopAPI["reviewFile"]>>;

/**
 * Side-by-side diff of the changed files, one file at a time, in Monaco (loaded on first use like
 * the editor). Binary and very large files are named but not rendered.
 */
export function DiffViewer({ api, taskId, paths, digest }: { api: DesktopAPI; taskId: string; paths: string[]; digest: string }) {
  const [selected, setSelected] = useState(paths[0] ?? "");
  const [versions, setVersions] = useState<Versions>();
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!paths.includes(selected)) setSelected(paths[0] ?? ""); }, [paths, selected]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setVersions(undefined); setError("");
    api.reviewFile(taskId, selected).then((value) => { if (live) setVersions(value); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [api, taskId, selected, digest]);

  useEffect(() => {
    if (!versions || versions.skipped || !host.current) return;
    let dispose: (() => void) | undefined;
    let live = true;
    void import("./monaco-runtime.js").then((runtime) => {
      if (live && host.current) dispose = runtime.createDiff(host.current, versions.path, versions.original ?? "", versions.modified ?? "");
    }, (e) => setError(`Diff görünümü yüklenemedi: ${String(e)}`));
    return () => { live = false; dispose?.(); };
  }, [versions]);

  if (!paths.length) return null;
  const state = !versions ? undefined : versions.original === null ? "Yeni dosya" : versions.modified === null ? "Silindi" : "Değişti";
  return <section className="diff-viewer" aria-label="Dosya karşılaştırması">
    <div className="diff-files" role="tablist" aria-label="Değişen dosyalar">
      {paths.map((path) => <button key={path} role="tab" aria-selected={path === selected} title={path} onClick={() => setSelected(path)}>
        {path.split("/").pop()}<small>{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}</small>
      </button>)}
    </div>
    <div className="diff-caption"><code>{selected}</code>{state && <span>{state}</span>}<small>Sol: önceki · Sağ: ajanın hali</small></div>
    {error && <p className="file-error" role="alert">{error}</p>}
    {versions?.skipped && <p className="review-warning">{versions.skipped === "binary" ? "İkili dosya; içerik gösterilmiyor." : "Dosya 1 MiB'tan büyük; çalışma alanında inceleyin."}</p>}
    {!versions?.skipped && <div className="diff-host" ref={host}>{!versions && !error && <p className="empty">Yükleniyor…</p>}</div>}
  </section>;
}
