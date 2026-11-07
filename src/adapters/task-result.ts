import type { AgentResult } from "../core/contracts.js";
import { record } from "./jsonl-rpc.js";
import { normalizeTestReports } from "../core/test-reports.js";
import { normalizeContextFacts } from "../core/context.js";

/**
 * Finds the result envelope in an agent's final message. Models do not always reply with the bare
 * JSON: they may explain first and put the envelope in a ```json fence or at the end of the text.
 */
function envelopeJson(summary: string): unknown {
  const trimmed = summary.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1").trim();
  try { return JSON.parse(trimmed); } catch { /* Not bare JSON; look inside the text. */ }
  const fenced = [...summary.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]!).reverse();
  for (const block of fenced) {
    if (!block.includes('"agentmeshVersion"')) continue;
    try { return JSON.parse(block.trim()); } catch { /* Try the next candidate. */ }
  }
  const start = summary.lastIndexOf('{"agentmeshVersion"');
  if (start >= 0) {
    // Trailing prose may follow the object; shrink to each closing brace until it parses.
    for (let end = summary.lastIndexOf("}"); end > start; end = summary.lastIndexOf("}", end - 1)) {
      try { return JSON.parse(summary.slice(start, end + 1)); } catch { /* Keep shrinking. */ }
    }
  }
  return undefined;
}

/** Versioned handoff envelope; ordinary prose remains a valid summary. */
export function normalizeTaskResult(base: AgentResult, recipients?: readonly string[]): AgentResult {
  const parsed = envelopeJson(base.summary);
  if (parsed === undefined) return base;
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
