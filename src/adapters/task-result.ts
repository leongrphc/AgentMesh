import type { AgentResult } from "../core/contracts.js";
import { record } from "./jsonl-rpc.js";

/** Versioned handoff envelope; ordinary prose remains a valid summary. */
export function normalizeTaskResult(base: AgentResult, recipients?: readonly string[]): AgentResult {
  const text = base.summary.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return base; }
  const value = record(parsed);
  if (!("agentmeshVersion" in value)) return base;
  if (value.agentmeshVersion !== 1 || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 65536)
    throw new Error("Geçersiz AgentMesh sonuç zarfı");
  if (!Array.isArray(value.facts) || value.facts.length > 32 || !Array.isArray(value.messages) || value.messages.length > 32)
    throw new Error("AgentMesh facts/messages dizisi gerekli; her biri en fazla 32 kayıt olabilir");
  const keys = new Set<string>();
  const facts = value.facts.map((entry) => {
    const fact = record(entry);
    if (typeof fact.key !== "string" || !fact.key.trim() || fact.key.length > 160 || /^(task\.|system\.)/.test(fact.key)
      || keys.has(fact.key) || typeof fact.value !== "string" || fact.value.length > 16384) throw new Error("Geçersiz veya tekrarlı ortak context kaydı");
    keys.add(fact.key); return { key: fact.key, value: fact.value };
  });
  const messages = value.messages.map((entry) => {
    const message = record(entry);
    if (typeof message.to !== "string" || !message.to.trim() || message.to.length > 200
      || (recipients && message.to !== "*" && !recipients.includes(message.to)) || !["handoff", "question", "progress"].includes(String(message.kind))
      || typeof message.body !== "string" || !message.body.trim() || message.body.length > 16384) throw new Error("Geçersiz ajan mesajı veya proje dışı alıcı");
    return { to: message.to, kind: message.kind as "handoff" | "question" | "progress", body: message.body };
  });
  return { summary: value.summary.trim(), sessionId: base.sessionId, facts, messages };
}
