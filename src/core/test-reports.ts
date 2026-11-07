import type { TestReport } from "./contracts.js";
import { safeLog } from "./safe-log.js";

const MAX_REPORTS = 32;
const STATUSES = new Set<TestReport["status"]>(["passed", "failed", "not_run"]);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Test reports are the agent's own claim, not evidence, and they are optional. A malformed report
 * must never discard finished work, so entries are repaired conservatively instead of rejected:
 * anything that is not an explicit "passed" or "failed" becomes "not_run" (never upgraded to passed),
 * oversized text is truncated, and non-object entries are dropped.
 */
export function normalizeTestReports(value: unknown, trusted = false): TestReport[] | undefined {
  if (value === undefined || value === null || !Array.isArray(value)) return undefined;
  const reports: TestReport[] = [];
  for (const entry of value.slice(0, MAX_REPORTS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const report = entry as Record<string, unknown>;
    const known = typeof report.status === "string" && STATUSES.has(report.status as TestReport["status"]);
    const status = known ? report.status as TestReport["status"] : "not_run";
    const name = text(report.name, 200) ?? "Test";
    const command = text(report.command, 2000);
    const reported = text(report.details, 8192);
    const details = known ? reported
      : [`Ajan tanınmayan bir durum bildirdi (${safeLog(String(JSON.stringify(report.status) ?? "yok").slice(0, 60))}); çalıştırılmadı sayıldı.`, reported].filter(Boolean).join(" ");
    // Only AgentMesh's own runs may carry the verified marker; an agent cannot claim it.
    const verified = trusted && report.source === "agentmesh";
    reports.push({ name: safeLog(name, "storage"), status, ...(verified ? { source: "agentmesh" as const } : {}),
      ...(command ? { command: safeLog(command, "storage") } : {}),
      ...(details ? { details: safeLog(details, "storage") } : {}) });
  }
  return reports.length ? reports : undefined;
}
