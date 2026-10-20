import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";
import type { MessageDraft, HistoryPage, MessageHistoryEntry } from "../src/core/contracts.js";

const deliveryLabels = { sending: "Gönderiliyor", accepted: "Kabul edildi", queued: "Sırada", uncertain: "Teslim belirsiz" };

export function Messages({ state, api, taskId, selectedOnly }: {
  state: DesktopState; api: DesktopAPI; taskId?: string; selectedOnly: boolean;
}) {
  const [to, setTo] = useState("*");
  const [kind, setKind] = useState<MessageDraft["kind"]>("progress");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submission = useRef<{ content: string; key: string }>(undefined);
  const inbox = state.snapshot.inboxes.find((inbox) => inbox.taskId === taskId);
  const agent = state.agents.find((agent) => agent.id === to);
  return <div className="messages-panel">
    <form data-testid="project-message-form" onSubmit={async (event) => {
      event.preventDefault(); setSending(true); setError(""); setNotice("");
      const content = JSON.stringify({ to, kind, body });
      if (submission.current?.content !== content) submission.current = { content, key: crypto.randomUUID() };
      try {
        await api.sendMessage({ to, kind, body, idempotencyKey: submission.current.key });
        setBody(""); submission.current = undefined;
        setNotice("Mesaj kaydedildi. Teslim durumu aşağıda görev bazında gösterilir.");
      } catch (error) { setError(String(error)); }
      finally { setSending(false); }
    }}>
      <div className="message-fields">
        <label>Alıcı<select aria-label="Mesaj alıcısı" value={to} disabled={sending} onChange={(event) => setTo(event.target.value)}>
          <option value="*">Tüm ajanlar</option>{state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
        </select></label>
        <label>Tür<select aria-label="Mesaj türü" value={kind} disabled={sending} onChange={(event) => setKind(event.target.value as MessageDraft["kind"])}>
          <option value="progress">Yönlendirme / ilerleme</option><option value="question">Soru</option>
        </select></label>
      </div>
      <label>Mesaj<textarea aria-label="Proje mesajı" rows={3} maxLength={16384} required value={body} disabled={sending}
        onChange={(event) => setBody(event.target.value)} /></label>
      <p>{agent ? agent.liveMessages ? "Aktif görevde canlı teslim desteklenir; görev yoksa sırada bekler." : "Bu bağlantıda mesaj sonraki görev veya açık yeniden denemede iletilir."
        : "Canlı teslim destekleyen aktif görevlere iletilir; diğer görevler için sırada bekler."}</p>
      <button type="submit" className="primary" disabled={sending || !body.trim()}>{sending ? "Kaydediliyor…" : "Mesajı kaydet ve ilet"}</button>
      {error && <p className="file-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </form>
    {inbox && <p className="inbox-status">Seçili görev: {inbox.cursor} ardışık mesaj kabul edildi · {inbox.pending} bekleyen · {inbox.uncertain} belirsiz</p>}
    <MessageHistory key={JSON.stringify([taskId, selectedOnly])} state={state} api={api} taskId={selectedOnly ? taskId : undefined} />
  </div>;
}


function MessageHistory({ state, api, taskId }: { state: DesktopState; api: DesktopAPI; taskId?: string }) {
  const [page, setPage] = useState<HistoryPage<MessageHistoryEntry>>();
  const [cursors, setCursors] = useState<number[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const before = cursors.at(-1);
  const { id, workspaceRoot } = state.snapshot.project;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    void api.messageHistory(id, workspaceRoot, taskId, before).then(result => {
      if (!cancelled) setPage(result);
    }, reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, workspaceRoot, taskId, before, refresh, state.historyCounts.messageRevision, api]);
  return <section aria-label="Mesaj geçmişi" aria-busy={loading}>
    <h3>Mesaj geçmişi{page ? ` · ${page.total}` : ""}</h3>
    {loading && <p role="status">Mesajlar yükleniyor…</p>}
    {error && <p className="file-error" role="alert">{error}</p>}
    {page && !page.entries.length && <p className="empty">Bu kapsamda mesaj yok.</p>}
    {page?.entries.map(({ message, deliveries, deliveryCount }) => <article className="context-item" key={message.id}>
      <b>{message.from === "@user" ? "Sen" : message.from} → {message.to === "*" ? "Tüm ajanlar" : message.to}</b>
      <p>{message.body}</p><small>{message.kind} · {message.taskId === "@user" ? "Kullanıcı mesajı" : message.taskId}</small>
      <p className="message-deliveries">{deliveries.length ? deliveries.map(delivery =>
        <span key={delivery.taskId}>{delivery.taskId}: {deliveryLabels[delivery.status]}{delivery.mode === "live" ? " · canlı" : " · görev istemi"}</span>) : "Teslim bekliyor"}</p>
      {deliveryCount > deliveries.length && <p>{deliveryCount - deliveries.length} teslim kaydı daha var. İlgili görevi seçip Seçili görev filtresini açın.</p>}
    </article>)}
    <div className="context-actions">
      <button disabled={loading || !cursors.length} onClick={() => setCursors(previous => previous.slice(0, -1))}>Daha yeni mesajlar</button>
      <button disabled={loading || !page?.nextBefore} onClick={() => { if (page?.nextBefore) setCursors(previous => [...previous, page.nextBefore!]); }}>Daha eski mesajlar</button>
      <button disabled={loading} onClick={() => { setCursors([]); setRefresh(value => value + 1); }}>En yeni mesajlar</button>
    </div>
  </section>;
}
