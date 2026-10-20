import type { AgentResult } from "../core/contracts.js";
import { record } from "./jsonl-rpc.js";
import { normalizeTestReports } from "../core/test-reports.js";
import { normalizeContextFacts } from "../core/context.js";

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
  const facts = normalizeContextFacts(value.facts);
  const messages = value.messages.map((entry) => {
    const message = record(entry);
    if (typeof message.to !== "string" || !message.to.trim() || message.to.length > 200
      || (recipients && message.to !== "*" && !recipients.includes(message.to)) || !["handoff", "question", "progress"].includes(String(message.kind))
      || typeof message.body !== "string" || !message.body.trim() || message.body.length > 16384) throw new Error("Geçersiz ajan mesajı veya proje dışı alıcı");
    return { to: message.to, kind: message.kind as "handoff" | "question" | "progress", body: message.body };
  });
  const tests = normalizeTestReports(value.tests);
  return { summary: value.summary.trim(), sessionId: base.sessionId, facts, messages, ...(tests ? { tests } : {}) };
}
