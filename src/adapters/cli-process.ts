import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentExecution } from "../core/contracts.js";

export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface ProcessResult {
  events: Record<string, unknown>[];
  stderr: string;
}

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

export const runJsonlProcess: ProcessRunner = async (spec) => {
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  const events: Record<string, unknown>[] = [];
  let stderr = "";
  let rawOutput = "";
  let parseError: Error | undefined;
  const timer = setTimeout(() => child.kill(), spec.timeoutMs ?? 10 * 60 * 1000);
  timer.unref();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (events.length < 20_000) events.push(value as Record<string, unknown>);
      } else if (rawOutput.length < 8192) rawOutput += line + "\n";
    } catch {
      if (rawOutput.length < 8192) rawOutput += line + "\n";
    }
    if (events.length >= 20_000) {
      parseError = new Error("CLI olay limiti aşıldı");
      child.kill();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => { stderr += text; stderr = stderr.slice(-8192); });
  if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
  else child.stdin.end();
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally { clearTimeout(timer); }
  if (parseError) throw parseError;
  if (exitCode !== 0) throw new Error(`CLI hata kodu ${exitCode}: ${stderr || rawOutput.slice(-1024)}`);
  return { events, stderr };
};

function nested(record: unknown, key: string): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  return (record as Record<string, unknown>)[key];
}

export function parseAgentEvents(events: readonly Record<string, unknown>[]): { summary: string; sessionId?: string } {
  let summary = "";
  let sessionId: string | undefined;
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    if (typeof event.sessionID === "string") sessionId = event.sessionID;
    const part = event.part;
    if (typeof nested(part, "sessionID") === "string") sessionId = nested(part, "sessionID") as string;
    if (event.type === "item.completed" && nested(event.item, "type") === "agent_message") {
      const text = nested(event.item, "text");
      if (typeof text === "string") summary = text;
    }
    if (event.type === "text") {
      const text = nested(part, "text");
      if (typeof text === "string") summary += text;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      throw new Error(`Ajan hatası: ${JSON.stringify(event).slice(0, 1000)}`);
    }
  }
  if (!summary.trim()) throw new Error("CLI başarılı bitti fakat ajan mesajı bulunamadı");
  return { summary: summary.trim(), sessionId };
}

export function buildPrompt(input: AgentExecution): string {
  const context = Object.values(input.context)
    .map((fact) => ({ key: fact.key, value: fact.value, sourceTaskId: fact.sourceTaskId }));
  return [
    `Proje: ${input.task.projectId}`,
    `Görev: ${input.task.title} (${input.task.id})`,
    `Talimat: ${input.task.instruction}`,
    `İzinli dosya desenleri: ${JSON.stringify(input.task.allowedPaths)}`,
    "Sadece izin verilen dosyaları değiştir. Proje dışına dokunma; commit, push, merge yapma.",
    `Güncel ortak context: ${JSON.stringify(context)}`,
    `Sana gelen mesajlar: ${JSON.stringify(input.inbox.map(({ from, kind, body }) => ({ from, kind, body })))}`,
    "Sonunda yapılan değişiklikleri ve test sonuçlarını kısaca açıkla.",
  ].join("\n\n");
}
