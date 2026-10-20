import type { AgentExecution } from "../core/contracts.js";
import { record } from "./jsonl-rpc.js";

/** Only completed assistant messages are eligible; tool stdout is never a message command. */
export function consumeLiveMessage(text: string, input: AgentExecution): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1")); }
  catch { return false; }
  const value = record(parsed);
  if (!("agentmeshMessageVersion" in value)) return false;
  if (value.agentmeshMessageVersion !== 1 || !input.sendMessage
    || typeof value.to !== "string" || typeof value.body !== "string" || typeof value.key !== "string"
    || (value.kind !== "progress" && value.kind !== "question")) throw new Error("Geçersiz canlı ajan mesajı");
  input.sendMessage({ to: value.to, kind: value.kind, body: value.body, idempotencyKey: value.key });
  return true;
}
