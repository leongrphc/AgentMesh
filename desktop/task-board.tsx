import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentTask } from "../src/core/contracts.js";
import type { DesktopState, TaskDraft } from "../src/desktop/contracts.js";

/** Readable, unique task id derived from the title, e.g. "giris-ekrani-k3f9". */
function taskId(title: string, taken: Set<string>): string {
  const base = title.toLocaleLowerCase("tr-TR").replace(/ı/g, "i").normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48) || "gorev";
  let id = base;
  while (taken.has(id)) id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  return id;
}

const lines = (value: FormDataEntryValue | null) => String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export function TaskForm({ state, onClose, onCreate }: {
  state: DesktopState; onClose: () => void; onCreate: (task: TaskDraft) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [contextMode, setContextMode] = useState("all");
  const title = useRef<HTMLInputElement>(null);
  // showModal focuses the first focusable element (the close button); start in the title instead.
  useEffect(() => { dialog.current?.showModal(); title.current?.focus(); }, []);
  const { tasks } = state.snapshot;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const title = String(values.get("title")).trim();
    setSaving(true); setError("");
    try {
      await onCreate({
        id: String(values.get("id") ?? "").trim() || taskId(title, new Set(tasks.map((task) => task.id))),
        title,
        instruction: String(values.get("instruction")).trim(),
        agentId: String(values.get("agentId")),
        dependsOn: values.getAll("dependsOn").map(String),
        allowedPaths: lines(values.get("allowedPaths")),
        ...(contextMode === "selected" ? { contextKeys: lines(values.get("contextKeys")) } : {}),
      });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return <dialog className="task-form review-dialog" ref={dialog} aria-labelledby="new-task-title"
    onCancel={(event) => { if (saving) event.preventDefault(); else onClose(); }}>
    <header className="review-header">
      <div><div className="eyebrow">Yeni görev</div><h2 id="new-task-title">Ajan ne yapsın?</h2></div>
      <button className="icon-button" disabled={saving} aria-label="Görev formunu kapat" onClick={onClose}>×</button>
    </header>
    <form onSubmit={submit}>
      <div className="review-content">
        {error && <p className="file-error" role="alert">{error}</p>}
        <label>Başlık<input name="title" ref={title} required maxLength={200} placeholder="Giriş ekranına şifre sıfırlama ekle" /></label>
        <label>Talimat<textarea name="instruction" required rows={6} maxLength={16000}
          placeholder="Ne yapılmalı, hangi dosyalar etkilenir, iş ne zaman bitmiş sayılır? Kabul kriterlerini yazın." /></label>
        <label>Ajan<select name="agentId" required>{state.agents.map((agent) => <option key={agent.id} value={agent.id}>
          {[agent.id, state.demo ? "demo" : agent.provider === agent.id ? undefined : agent.provider, agent.model].filter(Boolean).join(" · ")}</option>)}</select></label>

        {!!tasks.length && <fieldset>
          <legend>Önce bitmesi gereken görevler</legend>
          <div className="dependency-options">{tasks.map((task) => <label key={task.id}>
            <input type="checkbox" name="dependsOn" value={task.id} /><span>{task.title}<small>{task.id}</small></span>
          </label>)}</div>
          <p className="form-help">Seçilen görevler onaylanınca bu görev onların sonucunu ve özetini görerek başlar.</p>
        </fieldset>}

        <details className="advanced">
          <summary>Gelişmiş ayarlar</summary>
          <label>Görev kimliği<input name="id" maxLength={128} placeholder="Boş bırakılırsa başlıktan üretilir" /></label>
          <label>İzinli dosya desenleri<textarea name="allowedPaths" required rows={2} defaultValue={state.defaultAllowedPaths.join("\n")} /></label>
          <p className="form-help">Her satıra bir glob deseni. Ajan bunların dışında dosya değiştirirse inceleme onaylanamaz. <code>**</code> gizli olmayan tüm dosyalar demektir.</p>
          <label>Ortak context kapsamı<select name="contextMode" value={contextMode} onChange={(event) => setContextMode(event.target.value)}>
            <option value="all">Tüm proje kararları</option><option value="selected">Seçtiğim anahtarlar</option>
          </select></label>
          {contextMode === "selected" && <label>Context anahtarları<textarea name="contextKeys" rows={2} placeholder="api.contract" />
            <span className="form-help">Her satıra tam bir anahtar. Boş bırakırsanız yalnızca bağımlı görevlerin özetleri eklenir.</span></label>}
        </details>
      </div>
      <footer className="review-actions">
        <button type="button" disabled={saving} onClick={onClose}>Vazgeç</button>
        <button className="primary" disabled={saving || !state.agents.length}>{saving ? "Ekleniyor…" : "Görevi ekle"}</button>
      </footer>
    </form>
  </dialog>;
}

export function TaskGraph({ tasks, selected, onSelect }: { tasks: AgentTask[]; selected?: string; onSelect: (id: string) => void }) {
  if (!tasks.length || tasks.length > 100) return null;
  const known = new Map(tasks.map((task) => [task.id, task]));
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  function rank(id: string): number {
    if (ranks.has(id)) return ranks.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = known.get(id)?.dependsOn.filter((parent) => known.has(parent)) ?? [];
    const value = parents.length ? Math.max(...parents.map(rank)) + 1 : 0;
    ranks.set(id, value); visiting.delete(id); return value;
  }
  const slots = new Map<number, number>();
  const positions = new Map(tasks.map((task) => {
    const column = rank(task.id);
    const row = slots.get(column) ?? 0;
    slots.set(column, row + 1);
    return [task.id, { x: 15 + column * 205, y: 15 + row * 65 }];
  }));
  const width = Math.max(...[...positions.values()].map((p) => p.x)) + 190;
  const height = Math.max(...[...positions.values()].map((p) => p.y)) + 65;
  return <div className="graph-scroll"><svg className="task-graph" width={width} height={height} role="group" aria-label="Görev bağımlılıkları">
    {tasks.flatMap((task) => task.dependsOn.filter((id) => positions.has(id)).map((parent) => {
      const a = positions.get(parent)!, b = positions.get(task.id)!;
      return <path key={`${parent}:${task.id}`} d={`M ${a.x + 170} ${a.y + 21} C ${a.x + 187} ${a.y + 21}, ${b.x - 17} ${b.y + 21}, ${b.x} ${b.y + 21}`} />;
    }))}
    {tasks.map((task) => {
      const point = positions.get(task.id)!;
      return <g key={task.id} transform={`translate(${point.x},${point.y})`} tabIndex={0} role="button" aria-label={`${task.title}, önce: ${task.dependsOn.join(", ") || "bağımsız"}`} onClick={() => onSelect(task.id)} onKeyDown={(event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelect(task.id); } }}>
        <title>{task.title}</title><rect width={170} height={43} rx={5} className={selected === task.id ? "graph-selected" : ""} /><text x={12} y={18}>{task.title.length > 23 ? task.title.slice(0, 21) + "…" : task.title}</text><text className="graph-agent" x={12} y={32}>{task.agentId}</text>
      </g>;
    })}
  </svg></div>;
}
