import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor/editor/editor.api.js";
import type { WorkspaceEntry, WorkspaceFile } from "../src/core/workspace-files.js";
import type { DesktopAPI } from "../src/desktop/contracts.js";
import { maxEditorTabs, readDrafts, writeDrafts } from "./editor-drafts.js";

function language(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", css: "css", html: "html", md: "markdown", json: "json" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

type Tab = { file: WorkspaceFile; model: monaco.editor.ITextModel; view?: monaco.editor.ICodeEditorViewState | null; changed: boolean; missing: boolean };

export function FileEditor({ taskId, scope, api, busy, onDirty }: { taskId: string; scope: string; api: DesktopAPI; busy: boolean; onDirty: (dirty: boolean) => void }) {
  const [directory, setDirectory] = useState("");
  const [root, setRoot] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [file, setFile] = useState<WorkspaceFile>();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [writable, setWritable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState<"file" | "directory">("file");
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState("");
  const [tabPaths, setTabPaths] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(true);
  const [draftError, setDraftError] = useState("");
  const [diskWarning, setDiskWarning] = useState("");
  const [engineLoading, setEngineLoading] = useState(false);
  const runtime = useRef<typeof import("./monaco-runtime.js") | undefined>(undefined);
  const enginePromise = useRef<Promise<void> | undefined>(undefined);
  const tabs = useRef(new Map<string, Tab>());
  const selected = useRef<string | undefined>(undefined);
  const disposed = useRef(false);
  const restoring = useRef(true);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const request = useRef(0);
  useEffect(() => () => { request.current++; onDirty(false); }, [onDirty]);

  async function ensureEditor() {
    if (editor.current) return;
    if (!enginePromise.current) {
      setEngineLoading(true);
      enginePromise.current = import("./monaco-runtime.js").then((module) => {
        if (disposed.current || !host.current) throw new Error("Editör alanı kapandı");
        runtime.current = module;
        editor.current = module.createEditor(host.current);
      }).finally(() => {
        enginePromise.current = undefined;
        if (!disposed.current) setEngineLoading(false);
      });
    }
    await enginePromise.current;
  }

  function persistDrafts() {
    clearTimeout(persistTimer.current);
    if (restoring.current) return;
    try {
      writeDrafts(localStorage, scope, [...tabs.current.values()].filter((tab) => tab.model.getValue() !== tab.file.content)
        .map((tab) => ({ path: tab.file.path, content: tab.model.getValue(), baseContent: tab.file.content, baseDigest: tab.file.digest })));
      if (!disposed.current) setDraftError("");
    } catch (e) { if (!disposed.current) setDraftError(`Taslak kurtarma kaydı yazılamadı: ${String(e)}. Değişikliklerinizi diske kaydedin.`); }
  }
  function publish() {
    if (disposed.current) return;
    const tab = tabs.current.get(selected.current ?? "");
    setFile(tab?.file); setDirty(!!tab && tab.model.getValue() !== tab.file.content);
    setTabPaths([...tabs.current.keys()]);
    setDiskWarning(tab?.missing ? "Dosya okunamıyor veya silinmiş. Taslak korunuyor; dosyayı diskte geri getirip yeniden kontrol edin."
      : tab?.changed ? "Dosya diskte değişti. Taslak korunuyor; eski içerik üzerine kaydetme engellenir. Disk sürümünü almak için Yeniden aç kullanın." : "");
    onDirty([...tabs.current.values()].some((entry) => entry.model.getValue() !== entry.file.content));
  }
  function selectTab(path: string) {
    ++request.current;
    const previous = tabs.current.get(selected.current ?? "");
    if (previous) previous.view = editor.current?.saveViewState();
    selected.current = path;
    const tab = tabs.current.get(path)!;
    editor.current!.setModel(tab.model);
    if (tab.view) editor.current!.restoreViewState(tab.view);
    publish();
  }
  function addTab(value: WorkspaceFile, draft?: string) {
    const model = runtime.current!.createModel(draft ?? value.content, language(value.path));
    const tab: Tab = { file: value, model, changed: false, missing: false };
    tabs.current.set(value.path, tab);
    model.onDidChangeContent(() => {
      publish();
      clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(persistDrafts, 300);
    });
    return tab;
  }

  useEffect(() => {
    disposed.current = false;
    void (async () => {
      try {
        const drafts = readDrafts(localStorage, scope);
        if (drafts.length) await ensureEditor();
        if (disposed.current) return;
        for (const draft of drafts) {
          let disk: WorkspaceFile | undefined;
          try { disk = await api.readFile(taskId, draft.path); } catch { /* Keep unreadable drafts for recovery. */ }
          if (disposed.current) return;
          const tab = addTab({ path: draft.path, content: draft.baseContent, digest: draft.baseDigest, writable: disk?.writable ?? false }, draft.content);
          if (disk?.content === draft.content) { tab.file = disk; }
          else tab.changed = !!disk && disk.digest !== draft.baseDigest;
          tab.missing = !disk;
        }
        if (tabs.current.size) { selectTab(tabs.current.keys().next().value!); setNotice("Yerel taslaklar kurtarıldı. Disk dosyaları değiştirilmedi."); }
        restoring.current = false;
      } catch (e) { setDraftError(`Taslak kaydı okunamadı; korunması için yeni kurtarma kaydı kapatıldı: ${String(e)}`); }
      finally { if (!disposed.current) setRecovering(false); }
    })();
    const flush = () => persistDrafts();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("agentmesh:flush-drafts", flush);
    return () => {
      persistDrafts(); disposed.current = true; window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush);
      window.removeEventListener("agentmesh:flush-drafts", flush);
      clearTimeout(persistTimer.current); editor.current?.dispose();
      for (const tab of tabs.current.values()) tab.model.dispose();
      tabs.current.clear();
    };
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.files(taskId, directory).then((value) => { if (live) { setEntries(value.entries); setRoot(value.root); setWritable(value.writable); } })
      .catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, taskId, directory, revision, busy]);

  useEffect(() => { editor.current?.updateOptions({ readOnly: !file?.writable || busy }); }, [file?.writable, busy]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      for (const tab of tabs.current.values()) {
        const base = tab.file;
        try {
          const disk = await api.readFile(taskId, base.path);
          if (!live || tabs.current.get(base.path) !== tab || tab.file !== base) continue;
          tab.missing = false;
          if (disk.digest !== base.digest && tab.model.getValue() === base.content) {
            tab.file = disk; tab.model.setValue(disk.content); tab.changed = false;
          } else {
            tab.changed = disk.digest !== base.digest;
            tab.file = { ...base, writable: disk.writable };
          }
        } catch { if (live && tabs.current.get(base.path) === tab && tab.file === base) { tab.missing = true; tab.file = { ...base, writable: false }; } }
      }
      if (live) {
        try { const listing = await api.files(taskId, directory); if (live) { setEntries(listing.entries); setWritable(listing.writable); } }
        catch { /* Explicit refresh retains actionable directory errors. */ }
        if (live) { publish(); timer = setTimeout(() => void check(), 3000); }
      }
    }
    void check();
    return () => { live = false; clearTimeout(timer); };
  }, [api, taskId, busy, directory]);

  async function openFile(path: string, reload = false) {
    if (saving || creating || recovering) return;
    const existing = tabs.current.get(path);
    if (existing && !reload) { selectTab(path); return; }
    if (existing && existing.model.getValue() !== existing.file.content && !window.confirm("Bu dosyanın taslağı silinip disk sürümü açılsın mı?")) return;
    if (!existing && tabs.current.size >= maxEditorTabs) { setError("En fazla 20 dosya açılabilir; önce bir sekmeyi kapatın."); return; }
    const id = ++request.current;
    setError("");
    try {
      const value = await api.readFile(taskId, path);
      if (id !== request.current) return;
      await ensureEditor();
      if (id !== request.current || disposed.current) return;
      if (existing) { existing.file = value; existing.changed = false; existing.missing = false; existing.model.setValue(value.content); }
      else addTab(value);
      selectTab(path); persistDrafts();
    }
    catch (e) { if (id === request.current) setError(String(e)); }
  }

  function closeTab(path: string) {
    if (saving) return;
    const tab = tabs.current.get(path)!;
    if (tab.model.getValue() !== tab.file.content && !window.confirm("Bu sekmenin kaydedilmemiş taslağı silinsin mi?")) return;
    ++request.current; tabs.current.delete(path);
    if (selected.current === path) {
      const next = tabs.current.keys().next().value;
      if (next) selectTab(next);
      else { selected.current = undefined; editor.current!.setModel(null); }
    }
    tab.model.dispose(); publish(); persistDrafts();
  }

  async function createEntry(event: React.FormEvent) {
    event.preventDefault();
    if (creating || busy || !writable) return;
    setCreating(true); setError(""); setNotice("");
    try {
      const path = directory ? `${directory}/${newName}` : newName;
      const entry = await api.createEntry(taskId, path, newKind === "directory");
      setNewName(""); setRevision((value) => value + 1);
      setNotice(`${entry.path} oluşturuldu. Dosya ağacından açabilirsiniz.`);
    } catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }

  async function save() {
    if (!file || !dirty || saving || busy || !file.writable) return;
    setSaving(true); setError("");
    try {
      const tab = tabs.current.get(file.path)!;
      const content = tab.model.getValue();
      const saved = await api.saveFile(taskId, file.path, content, file.digest);
      // Preserve typing that happened while IPC was in flight.
      if (disposed.current || tabs.current.get(file.path) !== tab) return;
      tab.file = saved; tab.changed = false; tab.missing = false;
      publish(); persistDrafts();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  return <section className="file-workspace" aria-label="Görev dosyaları">
    <div className="file-heading"><h2>Dosyalar</h2><code title={root}>{root || "Çalışma alanı açılıyor…"}</code><span>{writable && !busy ? "Görev worktree’si" : "Salt okunur"}</span></div>
    {error && <p className="file-error" role="alert">{error}</p>}
    {draftError && <p className="file-error" role="alert">{draftError}</p>}
    {recovering && <p role="status">Yerel taslaklar kontrol ediliyor…</p>}
    {engineLoading && <p className="editor-hint" role="status">Editör yükleniyor…</p>}
    {diskWarning && <p className="file-error" role="status">{diskWarning}</p>}
    <div className="file-layout"><nav className="file-tree" aria-label="Dosya ağacı">
      <div className="directory-label"><code>{directory || "/"}</code>{directory && <button disabled={creating} aria-label="Üst klasör" onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>↑</button>}<button disabled={loading || creating} onClick={() => setRevision((value) => value + 1)}>Yenile</button></div>
      <form className="create-entry" onSubmit={createEntry} aria-label="Yeni dosya veya klasör">
        <label>Yeni öğe<select aria-label="Yeni öğe türü" value={newKind} disabled={!writable || busy || creating} onChange={(event) => setNewKind(event.target.value as "file" | "directory")}>
          <option value="file">Dosya</option><option value="directory">Klasör</option>
        </select></label>
        <label>Ad<input aria-label="Yeni öğe adı" value={newName} maxLength={255} required disabled={!writable || busy || creating}
          onChange={(event) => setNewName(event.target.value)} pattern={'[^/\\\\]+'} /></label>
        <button type="submit" disabled={!writable || busy || creating || !newName.trim()}>{creating ? "Oluşturuluyor…" : "Oluştur"}</button>
        {!writable && <p>Durdurulmuş görev worktree’sinde oluşturabilirsiniz.</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
      {loading ? <p className="empty">Açılıyor…</p> : entries.map((entry) => <button className={file?.path === entry.path ? "current-file" : ""} key={entry.path}
        disabled={creating || saving} onClick={() => entry.directory ? setDirectory(entry.path) : void openFile(entry.path)}><span>{entry.directory ? "▸" : "·"}</span>{entry.name}</button>)}
      {!loading && entries.length === 0 && <p className="empty">Klasör boş.</p>}
    </nav><div className="file-editor">
      <div className="file-tabs" role="tablist" aria-label="Açık dosyalar">{tabPaths.map((path) => {
        const tab = tabs.current.get(path)!;
        return <div key={path}><button role="tab" aria-selected={file?.path === path} onClick={() => selectTab(path)} title={path}>
          {path}{tab.model.getValue() !== tab.file.content ? " ●" : ""}</button><button disabled={saving} aria-label={`${path} dosyasını kapat`} onClick={() => closeTab(path)}>×</button></div>;
      })}</div>
      <div className="editor-toolbar"><code>{file ? `${file.path}${dirty ? " ●" : ""}` : "Dosya seçin"}</code><div>
      {file && <button disabled={saving} onClick={() => openFile(file.path, true)}>Yeniden aç</button>}
      <button disabled={!file?.writable || !dirty || saving || busy} onClick={save}>{saving ? "Kaydediliyor…" : "Kaydet"}</button>
    </div></div><div className="monaco-host" ref={host} />{!file && <p className="editor-hint">Soldan bir dosya seçin. Kaydetme yalnızca durdurulmuş görev worktree’sinde ve görev kapsamındaki dosyalarda kullanılabilir.</p>}</div></div>
  </section>;
}
