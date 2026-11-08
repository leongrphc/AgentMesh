import { useState } from "react";
import type { AgentConfig } from "../src/core/config.js";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

export function AgentSettings({ state, api }: { state: DesktopState; api: DesktopAPI }) {
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<AgentConfig>({ id: "", provider: "codex", transport: "app-server" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const busy = saving || state.busy || state.checkingAgents || !!state.testingProvider;
  const locked = !!selected && state.snapshot.tasks.some((task) =>
    task.agentId === selected && (task.status !== "pending" || !!task.sessionId || !!task.worktree));
  return <section className="provider-test agent-settings" aria-labelledby="agent-settings-title">
    <h3 id="agent-settings-title">Proje ajanları</h3>
    <p>Ajan ekle veya henüz çalışmamış bir ajanın ayarlarını düzenle. Ayarlar bu projede saklanır; kaydetmek modeli çalıştırmaz.</p>
    <label>Ajan seç<select aria-label="Düzenlenecek ajan" disabled={busy} value={selected} onChange={(event) => {
      const id = event.target.value;
      setSelected(id); setError(""); setSaved("");
      const agent = state.agents.find((item) => item.id === id);
      setDraft(agent ? { id: agent.id, provider: agent.provider, transport: agent.transport ?? "exec", model: agent.model, role: agent.role, codexHome: agent.codexHome }
        : { id: "", provider: "codex", transport: "app-server" });
    }}><option value="">Yeni ajan ekle</option>{state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}</select></label>
    {locked && <p role="status">Bu ajanın çalışma geçmişi var. Farklı ayarlar için “Yeni ajan ekle” seçeneğini kullanın.</p>}
    {state.demo && <p>Demo ajanları, seçilen sağlayıcıdan bağımsız olarak yerel mock ile çalışır.</p>}
    <form data-testid="agent-settings-form" onSubmit={async (event) => {
      event.preventDefault(); setError(""); setSaved("");
      if (!selected && state.agents.some((agent) => agent.id === draft.id.trim())) {
        setError("Bu ajan kimliği kullanılıyor. Farklı bir kimlik girin veya listeden ajanı seçin."); return;
      }
      setSaving(true);
      try {
        const value = { ...draft, id: draft.id.trim(), model: draft.model?.trim() || undefined, role: draft.role?.trim() || undefined,
          codexHome: draft.provider === "codex" ? draft.codexHome || undefined : undefined };
        await api.saveAgent(value);
        setSelected(value.id); setDraft(value); setSaved(`${value.id} kaydedildi.`);
      } catch (error) { setError(String(error)); }
      finally { setSaving(false); }
    }}>
      <fieldset disabled={busy || locked} className="agent-settings-fields">
        <div className="provider-test-fields">
          <label>Ajan kimliği<input name="agentId" required maxLength={200} value={draft.id} disabled={!!selected}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></label>
          <label>Sağlayıcı<select name="agentProvider" value={draft.provider} onChange={(event) => setDraft({
            ...draft, provider: event.target.value as AgentConfig["provider"], transport: "exec", model: undefined,
          })}><option value="codex">Codex</option><option value="opencode">OpenCode</option><option value="antigravity">Antigravity</option><option value="claude">Claude Code</option><option value="copilot">GitHub Copilot</option></select></label>
        </div>
        <div className="provider-test-fields">
          <label>Bağlantı<select name="agentTransport" value={draft.transport ?? "exec"} onChange={(event) => setDraft({ ...draft, transport: event.target.value as AgentConfig["transport"] })}>
            <option value="exec">{draft.provider === "copilot" ? "Native CLI / Official SDK" : "CLI / exec"}</option>{draft.provider === "codex" && <option value="app-server">CLI / App Server</option>}
            {draft.provider === "opencode" && <option value="server">CLI / HTTP Server</option>}
          </select></label>
          <label>Model (isteğe bağlı)<input name="agentModel" maxLength={200} placeholder={draft.provider === "opencode" ? "provider/model" : "Sağlayıcı varsayılanı"}
            value={draft.model ?? ""} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
        </div>
        {draft.provider === "copilot" && <p className="form-help">Resmî SDK, sürümle eşleşen native Copilot CLI ve yerel GitHub girişini kullanır. Dosya araçları görev kapsamıyla sınırlı ve tek istek izinlidir; shell, MCP ve ağ araçları kapalıdır. Testleri proje test komutuyla çalıştırın.</p>}
        {draft.provider === "codex" && <label>Codex hesabı / profili
          <select name="agentCodexHome" value={draft.codexHome ?? ""} onChange={(event) => setDraft({ ...draft, codexHome: event.target.value || undefined })}>
            <option value="">Varsayılan (~/.codex)</option>
            {state.codexProfiles.map((profile) => <option key={profile.path} value={profile.path}>{profile.name}</option>)}
            {draft.codexHome && !state.codexProfiles.some((profile) => profile.path === draft.codexHome) && <option value={draft.codexHome}>{draft.codexHome}</option>}
          </select>
          <span className="form-help">Her profil ayrı bir Codex hesabıdır (CODEX_HOME). ~/.codex-profiles altındaki klasörler otomatik listelenir.</span>
        </label>}
        <label>Rol talimatı (isteğe bağlı)<textarea name="agentRole" rows={3} maxLength={2000} placeholder="Örneğin: Test kapsamını ve hata durumlarını incele."
          value={draft.role ?? ""} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
        <button type="submit" className="primary">{saving ? "Kaydediliyor…" : selected ? "Ajanı güncelle" : "Ajan ekle"}</button>
      </fieldset>
      {error && <p className="file-error" role="alert">{error}</p>}
      {saved && <p role="status">{saved}</p>}
    </form>
  </section>;
}
