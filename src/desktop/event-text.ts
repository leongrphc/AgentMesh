import type { AgentOutput, DomainEvent } from "../core/contracts.js";

const DOMAIN_LABELS: Partial<Record<DomainEvent["type"], string>> = {
  "project.created": "Proje oluşturuldu",
  "project.agents.configured": "Ajan ayarları kaydedildi",
  "project.parallelism.updated": "Paralel ajan sayısı değişti",
  "project.settings.updated": "Proje ayarları güncellendi",
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
  "task.reassigned": "Görev başka ajana devredildi",
  "task.changes.requested": "İncelemede değişiklik istendi; görev ajana geri döndü",
  "permission.requested": "Ajan izin istiyor",
  "permission.resolved": "İzin kararı verildi",
  "context.updated": "Ortak context güncellendi",
  "context.conflict.created": "Ortak context'te çakışma var",
  "context.conflict.resolved": "Context çakışması çözüldü",
  "message.sent": "Ajan mesajı gönderildi",
  "message.delivery": "Mesaj teslim edildi",
};

export function describeEvent(event: DomainEvent): string {
  if (event.type === "task.usage.recorded") {
    const cost = event.usage?.costUsd !== undefined ? ` · ${formatCost(event.usage.costUsd)}` : "";
    const tokens = event.usage?.inputTokens || event.usage?.outputTokens ? ` · ${formatTokens((event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0))} token` : "";
    return `Ajan çalışması bitti: ${formatDuration(event.durationMs)}${cost}${tokens}`;
  }
  if (event.type === "task.reassigned") return `Görev ${event.previousAgentId} ajanından ${event.agentId} ajanına devredildi`;
  const label = DOMAIN_LABELS[event.type] ?? event.type;
  const error = "error" in event && typeof event.error === "string" ? event.error : undefined;
  return error ? `${label}: ${clip(error, 300)}` : label;
}

export function eventTaskId(event: DomainEvent): string | undefined {
  if ("taskId" in event && typeof event.taskId === "string") return event.taskId;
  return event.type === "task.created" ? event.task.id : undefined;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} sn` : `${Math.floor(seconds / 60)} dk ${seconds % 60} sn`;
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0,01" : "$" + usd.toFixed(2).replace(".", ",");
}

export function formatTokens(count: number): string {
  return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1).replace(".", ",")} M` : count >= 1000 ? `${Math.round(count / 1000)} B` : String(count);
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

/** Last two path segments: enough to recognise a file without the long worktree prefix. */
function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

/**
 * Agent text may be one of AgentMesh's own JSON envelopes: the final result (shown as the task
 * result instead, so skipped here) or a live message to other agents (shown by its body).
 */
function describeAgentText(text: string): string | undefined {
  // Models sometimes wrap the envelope in a ```json fence.
  const envelope = parseLine(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"));
  if (envelope && "agentmeshVersion" in envelope) return undefined;
  if (envelope && "agentmeshMessageVersion" in envelope && typeof envelope.body === "string") {
    const to = typeof envelope.to === "string" && envelope.to !== "*" ? ` → ${envelope.to}` : "";
    return `Ajan mesajı${to}: ${clip(envelope.body, 300)}`;
  }
  return `Ajan: ${clip(text)}`;
}

function describeItem(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const text = typeof item.text === "string" ? item.text : undefined;
  if ((item.type === "agentMessage" || item.type === "agent_message") && text) return describeAgentText(text);
  const command = typeof item.command === "string" ? item.command : undefined;
  if ((item.type === "commandExecution" || item.type === "command_execution") && command) return `Komut çalıştı: ${clip(command, 200)}`;
  if (item.type === "fileChange" || item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes.map((change) => record(change)?.path)
      .filter((path): path is string => typeof path === "string").map(shortPath) : [];
    return changes.length ? `Dosya değişti: ${clip(changes.join(", "), 240)}` : "Dosya değişikliği yapıldı";
  }
  return undefined;
}

const TOOL_LABEL: Record<string, string> = { Read: "Okuyor", Edit: "Düzenliyor", Write: "Yazıyor", Glob: "Dosya arıyor", Grep: "İçerik arıyor", Bash: "Komut" };

/** Claude Code stream-json assistant turn: tool calls and final text. */
function describeClaudeTurn(data: Record<string, unknown>): string | undefined {
  const content = record(data.message)?.content;
  if (!Array.isArray(content)) return undefined;
  const lines: string[] = [];
  for (const block of content.map(record)) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      const line = describeAgentText(block.text);
      if (line) lines.push(line);
    } else if (block?.type === "tool_use" && typeof block.name === "string") {
      const input = record(block.input) ?? {};
      // File targets are shortened to their last segments; commands are shown as written.
      const file = [input.file_path, input.path].find((value): value is string => typeof value === "string");
      const other = [input.pattern, input.command].find((value): value is string => typeof value === "string");
      const shortTarget = file ? shortPath(file) : other;
      lines.push(`${TOOL_LABEL[block.name] ?? block.name}${shortTarget ? `: ${clip(shortTarget, 160)}` : ""}`);
    }
  }
  return lines.length ? lines.join(" · ") : undefined;
}

/** Headless CLI JSONL events (codex exec, opencode run, claude stream-json and similar). */
function describeJsonl(data: Record<string, unknown>): string | undefined {
  switch (data.type) {
    case "assistant": return describeClaudeTurn(data);
    case "item.completed": return describeItem(record(data.item));
    case "turn.failed": case "error": {
      const error = record(data.error);
      const message = typeof data.message === "string" ? data.message : typeof error?.message === "string" ? error.message : "Bilinmeyen hata";
      return `Sağlayıcı hatası: ${clip(message, 300)}${/10061|ECONNREFUSED/.test(message) ? REFUSED_HINT : ""}`;
    }
    default: return undefined;
  }
}
