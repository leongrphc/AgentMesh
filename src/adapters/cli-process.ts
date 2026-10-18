import { spawn } from "node:child_process";
import { safeLog } from "../core/safe-log.js";
import type { AgentExecution, AgentOutput } from "../core/contracts.js";

export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  maxLineBytes?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (output: AgentOutput) => void;
}

export interface ProcessResult {
  events: Record<string, unknown>[];
  stderr: string;
}

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

export const runJsonlProcess: ProcessRunner = async (spec) => {
  if (spec.signal?.aborted) throw new Error("CLI işlemi iptal edildi");
  const maxLineBytes = spec.maxLineBytes ?? 1024 * 1024;
  const maxOutputBytes = spec.maxOutputBytes ?? 16 * 1024 * 1024;
  for (const limit of [maxLineBytes, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("CLI çıktı sınırı pozitif tamsayı olmalı");
    }
  }
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  const events: Record<string, unknown>[] = [];
  let stderr = "";
  let stdoutBuffer = "";
  let outputBytes = 0;
  let rawOutput = "";
  let parseError: Error | undefined;
  let aborted = false;
  let timedOut = false;
  const abort = () => { aborted = true; child.kill(); };
  spec.signal?.addEventListener("abort", abort, { once: true });
  if (spec.signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, spec.timeoutMs ?? 10 * 60 * 1000);
  timer.unref();
  const report = (output: AgentOutput) => {
    try { spec.onOutput?.(output); } catch { /* UI subscriber failures must not crash CLI execution. */ }
  };
  const failLimit = (message: string) => {
    parseError ??= new Error(message);
    stdoutBuffer = "";
    child.kill();
  };
  const consumeLine = (line: string) => {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (events.length < 20_000) events.push(value as Record<string, unknown>);
        report({ channel: "stdout", data: { text: safeLog(JSON.stringify(value)) } });
      } else if (rawOutput.length < 8192) rawOutput += line + "\n";
    } catch {
      if (rawOutput.length < 8192) rawOutput += line + "\n";
    }
    if (events.length >= 20_000) {
      parseError = new Error("CLI olay limiti aşıldı");
      child.kill();
    }
  };
  const countBytes = (text: string) => {
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > maxOutputBytes) failLimit("CLI toplam çıktı byte limiti aşıldı");
    return !parseError;
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    if (!countBytes(text)) return;
    stdoutBuffer += text;
    let newline: number;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) return failLimit("CLI JSONL satır byte limiti aşıldı");
      consumeLine(line);
      if (parseError) return;
    }
    if (Buffer.byteLength(stdoutBuffer) > maxLineBytes) failLimit("CLI JSONL satır byte limiti aşıldı");
  });
  // stderr has no framing contract. Buffer until close so split credentials and
  // multiline private keys cannot leak through a partially filtered chunk.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    if (countBytes(text)) stderr += text;
  });
  child.stdin.on("error", () => { /* A child may exit before it accepts all stdin. */ });
  if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
  else child.stdin.end();
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener("abort", abort);
  }
  if (!parseError && stdoutBuffer) consumeLine(stdoutBuffer);
  stderr = safeLog(stderr);
  if (stderr) report({ channel: "stderr", data: stderr });
  if (parseError) throw parseError;
  if (aborted) throw new Error("CLI işlemi iptal edildi");
  if (timedOut) throw new Error("CLI zaman aşımı");
  if (exitCode !== 0) throw new Error(`CLI hata kodu ${exitCode}: ${safeLog(stderr || rawOutput, "storage")}`);
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
      throw new Error(`Ajan hatası: ${safeLog(JSON.stringify(event), "storage")}`);
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
