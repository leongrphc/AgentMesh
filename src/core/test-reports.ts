import type { TestReport } from "./contracts.js";
import { safeLog } from "./safe-log.js";

export function normalizeTestReports(value: unknown): TestReport[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error("Test raporları en fazla 32 kayıt içermeli");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Geçersiz test raporu");
    const report = entry as Record<string, unknown>;
    if (typeof report.name !== "string" || !report.name.trim() || report.name.length > 200
      || typeof report.status !== "string" || !["passed", "failed", "not_run"].includes(report.status)
      || (report.command !== undefined && (typeof report.command !== "string" || !report.command.trim() || report.command.length > 2000))
      || (report.details !== undefined && (typeof report.details !== "string" || report.details.length > 8192))) {
      throw new Error("Geçersiz test adı, durumu veya açıklaması");
    }
    return { name: safeLog(report.name.trim(), "storage"), status: report.status as TestReport["status"],
      ...(typeof report.command === "string" ? { command: safeLog(report.command, "storage") } : {}),
      ...(typeof report.details === "string" ? { details: safeLog(report.details, "storage") } : {}) };
  });
}
