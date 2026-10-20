import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import type { WorkspaceEntry, WorkspaceFile } from "../src/core/workspace-files.js";
import type { DesktopAPI } from "../src/desktop/contracts.js";

// Workers and styles ship with the app; no CDN or external code is loaded.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme("agentmesh", { base: "vs-dark", inherit: true, rules: [], colors: {
  "editor.background": "#15232e", "editorLineNumber.foreground": "#657c8c",
  "editor.lineHighlightBackground": "#203441", "editorCursor.foreground": "#78d2c6",
} });

function language(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", css: "css", html: "html", md: "markdown", json: "json" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

export function FileEditor({ taskId, api, busy, onDirty }: { taskId: string; api: DesktopAPI; busy: boolean; onDirty: (dirty: boolean) => void }) {
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
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const request = useRef(0);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => { request.current++; onDirty(false); }, [onDirty]);

  useEffect(() => {
    const instance = monaco.editor.create(host.current!, { value: "", language: "plaintext", theme: "agentmesh",
      readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
      fontFamily: "Consolas, monospace", scrollBeyondLastLine: false, padding: { top: 15 },
      unicodeHighlight: { ambiguousCharacters: false }, ariaLabel: "Görev dosyası editörü" });
    editor.current = instance;
    const change = instance.onDidChangeModelContent(() => setDirty(true));
    return () => { change.dispose(); const model = instance.getModel(); instance.dispose(); model?.dispose(); };
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.files(taskId, directory).then((value) => { if (live) { setEntries(value.entries); setRoot(value.root); setWritable(value.writable); } })
      .catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, taskId, directory, revision, busy]);

  useEffect(() => { editor.current?.updateOptions({ readOnly: !file?.writable || busy }); }, [file?.writable, busy]);

  function showFile(value: WorkspaceFile) {
    editor.current!.setValue(value.content);
    monaco.editor.setModelLanguage(editor.current!.getModel()!, language(value.path));
    setFile(value); setDirty(false);
  }

  async function openFile(path: string) {
    if (saving || creating) return;
    if (dirty && !window.confirm("Kaydedilmemiş değişiklikler silinsin mi?")) return;
    const id = ++request.current;
    setError("");
    try { const value = await api.readFile(taskId, path); if (id === request.current) showFile(value); }
    catch (e) { if (id === request.current) setError(String(e)); }
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
      const content = editor.current!.getValue();
      const saved = await api.saveFile(taskId, file.path, content, file.digest);
      // Preserve typing that happened while IPC was in flight.
      setFile(saved); setDirty(editor.current!.getValue() !== content);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  return <section className="file-workspace" aria-label="Görev dosyaları">
    <div className="file-heading"><h2>Dosyalar</h2><code title={root}>{root || "Çalışma alanı açılıyor…"}</code><span>{writable && !busy ? "Görev worktree’si" : "Salt okunur"}</span></div>
    {error && <p className="file-error" role="alert">{error}</p>}
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
    </nav><div className="file-editor"><div className="editor-toolbar"><code>{file ? `${file.path}${dirty ? " ●" : ""}` : "Dosya seçin"}</code><div>
      {file && <button disabled={saving} onClick={() => openFile(file.path)}>Yeniden aç</button>}
      <button disabled={!file?.writable || !dirty || saving || busy} onClick={save}>{saving ? "Kaydediliyor…" : "Kaydet"}</button>
    </div></div><div className="monaco-host" ref={host} />{!file && <p className="editor-hint">Soldan bir dosya seçin. Kaydetme yalnızca durdurulmuş görev worktree’sinde ve görev kapsamındaki dosyalarda kullanılabilir.</p>}</div></div>
  </section>;
}
