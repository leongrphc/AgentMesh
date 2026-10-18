import { useEffect, useRef, useState } from "react";
import type { AgentTask } from "../src/core/contracts.js";
import type { DesktopState, TaskDraft } from "../src/desktop/contracts.js";

export function TaskForm({ state, onClose, onCreate }: {
  state: DesktopState; onClose: () => void; onCreate: (task: TaskDraft) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="task-form review-dialog" ref={dialog} onCancel={(event) => { if (saving) event.preventDefault(); else onClose(); }} aria-labelledby="new-task-title">
    <div className="review-header"><div><div className="eyebrow">GÖREV PLANLAMA</div><h2 id="new-task-title">Yeni görev</h2></div><button disabled={saving} aria-label="Görev formunu kapat" onClick={onClose}>×</button></div>
    <form onSubmit={async (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      setSaving(true); setError("");
      try {
        await onCreate({ id: String(values.get("id")).trim(), title: String(values.get("title")).trim(),
          instruction: String(values.get("instruction")).trim(), agentId: String(values.get("agentId")),
          dependsOn: values.getAll("dependsOn").map(String),
          allowedPaths: String(values.get("allowedPaths")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) });
        onClose();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setSaving(false); }
    }}><div className="review-content">
      {error && <p className="file-error" role="alert">{error}</p>}
      <div className="form-pair"><label>Görev kimliği<input name="id" required maxLength={128} placeholder="backend-auth" /></label><label>Ajan<select name="agentId" required>{state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}</select></label></div>
      <label>Başlık<input name="title" required maxLength={200} placeholder="Giriş servisini geliştir" /></label>
      <label>Talimat<textarea name="instruction" required rows={4} maxLength={16000} placeholder="Beklenen davranışı ve kabul kriterlerini yazın." /></label>
      <label>İzinli dosya desenleri<textarea name="allowedPaths" required rows={2} defaultValue={"src/**"} /></label><p className="form-help">Her satıra bir desen. Dosya değişiklikleri görev sonunda bu kapsamla denetlenir.</p>
      <fieldset><legend>Önce tamamlanması gereken görevler</legend><div className="dependency-options">{state.snapshot.tasks.map((task) => <label key={task.id}><input type="checkbox" name="dependsOn" value={task.id} /><span>{task.title}<small>{task.id}</small></span></label>)}</div>{!state.snapshot.tasks.length && <p className="form-help">İlk görev bağımsız başlayacak.</p>}</fieldset>
    </div><div className="review-actions"><button type="button" disabled={saving} onClick={onClose}>Vazgeç</button><button className="primary" disabled={saving || !state.agents.length}>{saving ? "Ekleniyor…" : "Görevi ekle"}</button></div></form>
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
