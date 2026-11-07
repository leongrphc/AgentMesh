import type { AgentOutput, DomainEvent } from "../core/contracts.js";

const DOMAIN_LABELS: Partial<Record<DomainEvent["type"], string>> = {
  "project.created": "Proje oluşturuldu",
  "project.agents.configured": "Ajan ayarları kaydedildi",
  "project.parallelism.updated": "Paralel ajan sayısı değişti",
  "task.created": "Görev eklendi",
  "task.worktree.prepared": "Ayrı çalışma alanı (worktree) hazırlandı",
  "task.started": "Ajan çalışmaya başladı",
  "task.context.prepared": "Ortak context paketi hazırlandı",
  "task.session.saved": "Ajan oturumu kaydedildi",
  "task.review.requested": "Değişiklikler incelemenizi bekliyor",
  "task.review.approved": "Değişiklikler onaylandı ve birleştirildi",
  "task.merge.conflicted": "Birleştirmede çakışma çıktı",
  "task.merge.prepared": "Çakışma çözümü hazırlandı",
  "task.completed": "Görev tamamlandı",
  "task.failed": "Görev başarısız oldu",
  "task.blocked": "Görev engellendi",
  "task.cancelled": "Görev iptal edildi",
  "task.interrupted": "Görev yarıda kesildi",
  "task.retried": "Görev yeniden kuyruğa alındı",
  "permission.requested": "Ajan izin istiyor",
  "permission.resolved": "İzin kararı verildi",
  "context.updated": "Ortak context güncellendi",
  "context.conflict.created": "Ortak context'te çakışma var",
  "context.conflict.resolved": "Context çakışması çözüldü",
  "message.sent": "Ajan mesajı gönderildi",
  "message.delivery": "Mesaj teslim edildi",
};

export function describeEvent(event: DomainEvent): string {
  const label = DOMAIN_LABELS[event.type] ?? event.type;
  const error = "error" in event && typeof event.error === "string" ? event.error : undefined;
  return error ? `${label}: ${clip(error, 300)}` : label;
}

export function eventTaskId(event: DomainEvent): string | undefined {
  if ("taskId" in event && typeof event.taskId === "string") return event.taskId;
  return event.type === "task.created" ? event.task.id : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Hint appended when a provider cannot reach its model endpoint at all. */
const REFUSED_HINT = " — Model sunucusuna bağlanılamadı. Sağlayıcının kendi ayarındaki adresi (Codex için ~/.codex/config.toml içindeki openai_base_url) ve proxy/köprü uygulamasının çalıştığını kontrol edin.";

/** Provider adapters wrap each JSON line as `{ text: "<json>" }`; recover the structured message. */
function parseLine(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try { return record(JSON.parse(text)); } catch { return undefined; }
}

/**
 * Turns raw provider output into one readable activity line, or undefined for protocol noise
 * (MCP startup, hooks, streaming deltas, account notices) that only clutters the activity feed.
 */
export function describeOutput(output: AgentOutput): string | undefined {
  if (output.channel === "stderr") return clip(String(output.data));
  const data = record(output.data);
  if (!data) return clip(JSON.stringify(output.data));
  if (typeof data.text === "string") {
    const parsed = parseLine(data.text);
    return parsed ? describeMessage(parsed) : clip(data.text);
  }
  return describeMessage(data);
}

function describeMessage(data: Record<string, unknown>): string | undefined {
  if (typeof data.method === "string") return describeRpc(data.method, record(data.params) ?? {});
  if (typeof data.type === "string") return describeJsonl(data);
  return undefined;
}

/** Codex App Server JSON-RPC notifications. */
function describeRpc(method: string, params: Record<string, unknown>): string | undefined {
  switch (method) {
    case "turn/started": return "Model turu başladı";
    case "turn/completed": return "Model turu bitti";
    case "warning": return typeof params.message === "string" ? `Uyarı: ${clip(params.message, 240)}` : undefined;
    case "error": {
      const error = record(params.error);
      const message = typeof error?.message === "string" ? error.message : "Bilinmeyen hata";
      const details = typeof error?.additionalDetails === "string" ? error.additionalDetails : "";
      return `Sağlayıcı hatası: ${clip(details ? `${message} — ${details}` : message, 300)}${/10061|ECONNREFUSED/.test(details) ? REFUSED_HINT : ""}`;
    }
    case "item/completed": return describeItem(record(params.item));
    default: return undefined;
  }
}

function describeItem(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const text = typeof item.text === "string" ? item.text : undefined;
  if ((item.type === "agentMessage" || item.type === "agent_message") && text) return `Ajan: ${clip(text)}`;
  const command = typeof item.command === "string" ? item.command : undefined;
  if ((item.type === "commandExecution" || item.type === "command_execution") && command) return `Komut çalıştı: ${clip(command, 200)}`;
  if (item.type === "fileChange" || item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes.map((change) => record(change)?.path).filter((path): path is string => typeof path === "string") : [];
    return changes.length ? `Dosya değişti: ${clip(changes.join(", "), 240)}` : "Dosya değişikliği yapıldı";
  }
  return undefined;
}

/** Headless CLI JSONL events (codex exec, opencode run and similar). */
function describeJsonl(data: Record<string, unknown>): string | undefined {
  switch (data.type) {
    case "item.completed": return describeItem(record(data.item));
    case "turn.failed": case "error": {
      const error = record(data.error);
      const message = typeof data.message === "string" ? data.message : typeof error?.message === "string" ? error.message : "Bilinmeyen hata";
      return `Sağlayıcı hatası: ${clip(message, 300)}${/10061|ECONNREFUSED/.test(message) ? REFUSED_HINT : ""}`;
    }
    default: return undefined;
  }
}
