import { useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

/** Per-project automation: the test command AgentMesh runs itself, and automatic continuation. */
export function ProjectSettings({ state, api }: { state: DesktopState; api: DesktopAPI }) {
  const current = state.snapshot.project.settings ?? {};
  const [testCommand, setTestCommand] = useState(current.testCommand ?? "");
  const [autoContinue, setAutoContinue] = useState(!!current.autoContinue);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const changed = testCommand.trim() !== (current.testCommand ?? "") || autoContinue !== !!current.autoContinue;

  return <section className="provider-test project-settings" aria-labelledby="project-settings-title">
    <h3 id="project-settings-title">Proje ayarları</h3>
    <form onSubmit={async (event) => {
      event.preventDefault(); setSaving(true); setMessage("");
      try { await api.updateSettings({ ...current, testCommand: testCommand.trim() || undefined, autoContinue }); setMessage("Kaydedildi."); }
      catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
      finally { setSaving(false); }
    }}>
      <label>Test komutu
        <input name="testCommand" value={testCommand} maxLength={1000} disabled={state.busy || saving}
          placeholder="ör. npm ci && npm test" onChange={(event) => setTestCommand(event.target.value)} />
        <span className="form-help">Her görev bittiğinde AgentMesh bu komutu görevin çalışma alanında kendisi çalıştırır ve sonucu incelemede “Doğrulandı” olarak gösterir. Çalışma alanlarında bağımlılıklar kurulu olmadığından gerekirse kurulum komutunu da ekleyin. Boş bırakılırsa çalıştırılmaz.</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={autoContinue} disabled={state.busy || saving} onChange={(event) => setAutoContinue(event.target.checked)} />
        <span><b>Otomatik devam</b> · Onayladığınızda ya da değişiklik istediğinizde, başlamaya hazır görevler beklemeden başlar.</span>
      </label>
      <div className="provider-test-actions">
        <small role="status">{message}</small>
        <button className="primary" disabled={state.busy || saving || !changed}>{saving ? "Kaydediliyor…" : "Ayarları kaydet"}</button>
      </div>
    </form>
  </section>;
}
