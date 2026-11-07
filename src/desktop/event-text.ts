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

/**
 * Turns raw provider output into one readable activity line, or undefined for protocol noise
 * (MCP startup, hooks, streaming deltas, account notices) that only clutters the activity feed.
 */
export function describeOutput(output: AgentOutput): string | undefined {
  if (output.channel === "stderr") return clip(String(output.data));
  const data = record(output.data);
  if (!data) return clip(JSON.stringify(output.data));
  if (typeof data.text === "string") return clip(data.text);
  if (typeof data.method !== "string") return clip(JSON.stringify(data));
  const params = record(data.params) ?? {};
  switch (data.method) {
    case "turn/started": return "Model turu başladı";
    case "turn/completed": return "Model turu bitti";
    case "warning": return typeof params.message === "string" ? `Uyarı: ${clip(params.message, 240)}` : undefined;
    case "error": {
      const error = record(params.error);
      const message = typeof error?.message === "string" ? error.message : "Bilinmeyen hata";
      const details = typeof error?.additionalDetails === "string" ? ` — ${error.additionalDetails}` : "";
      return `Sağlayıcı hatası: ${clip(message + details, 300)}`;
    }
    case "item/completed": {
      const item = record(params.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") return `Ajan: ${clip(item.text)}`;
      if (item?.type === "commandExecution" && typeof item.command === "string") return `Komut çalıştı: ${clip(item.command, 200)}`;
      if (item?.type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes.map((change) => record(change)?.path).filter((path): path is string => typeof path === "string") : [];
        return changes.length ? `Dosya değişti: ${clip(changes.join(", "), 240)}` : "Dosya değişikliği yapıldı";
      }
      return undefined;
    }
    default: return undefined;
  }
}
