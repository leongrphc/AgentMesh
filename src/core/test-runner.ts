import { spawn } from "node:child_process";
import type { TestReport } from "./contracts.js";
import { safeLog } from "./safe-log.js";

/**
 * Only the end of the output is kept: that is where test runners print their summary. It stays
 * under the 2048-character storage limit of safeLog, which would otherwise cut the end off.
 */
const OUTPUT_TAIL = 1800;
export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface TestRun {
  report: TestReport;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Runs the project's test command in a task worktree, independently of what the agent claims.
 * The command goes through the platform shell so users can write "npm ci && npm test".
 */
export function runTestCommand(command: string, cwd: string, signal?: AbortSignal, timeoutMs = DEFAULT_TEST_TIMEOUT_MS): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Test komutu iptal edildi")); return; }
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 2); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const stop = () => {
      if (child.exitCode !== null || child.killed) return;
      // The shell's children (npm, node, ...) must go too; on Windows only taskkill /T reaches them.
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGTERM");
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { reject(new Error("Test komutu iptal edildi")); return; }
      const durationMs = Date.now() - started;
      const tail = output.slice(-OUTPUT_TAIL).trim();
      const passed = code === 0 && !timedOut;
      const reason = timedOut ? `${Math.round(timeoutMs / 1000)} saniyede bitmedi ve durduruldu.` : `Çıkış kodu ${code ?? "yok"}.`;
      resolve({
        exitCode: code,
        durationMs,
        report: {
          name: "Proje testleri (AgentMesh çalıştırdı)",
          status: passed ? "passed" : "failed",
          command: safeLog(command, "storage"),
          details: safeLog(`${reason} Süre: ${(durationMs / 1000).toFixed(1)} sn.${tail ? `\n${tail}` : ""}`, "storage"),
          source: "agentmesh",
        },
      });
    });
  });
}
