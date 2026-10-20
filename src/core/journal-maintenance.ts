import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Orchestrator } from "./orchestrator.js";
import type { SqliteJournal } from "./sqlite-journal.js";

export interface JournalMaintenancePolicy {
  maxActiveEvents?: number;
  maxActivePayloadBytes?: number;
  maxActiveAgeHours?: number;
}

const limits = {
  maxActiveEvents: [100, 10000000],
  maxActivePayloadBytes: [1024, 1024 ** 4],
  maxActiveAgeHours: [1, 87600],
} as const;

export function validateJournalMaintenance(value: JournalMaintenancePolicy | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.keys(value).length || Object.keys(value).some(key => !Object.hasOwn(limits, key))) {
    throw new Error("journalMaintenance için en az bir geçerli olay, içerik boyutu veya yaş eşiği gerekli");
  }
  for (const key of Object.keys(value) as Array<keyof JournalMaintenancePolicy>) {
    const number = value[key];
    const [min, max] = limits[key];
    if (!Number.isSafeInteger(number) || number! < min || number! > max) throw new Error(`journalMaintenance.${key} ${min}-${max} aralığında olmalı`);
  }
}

/** Opt-in, idle-boundary rotation. Archives are required history, never automatically deleted. */
export function maintainJournal(journal: SqliteJournal, engine: Orchestrator, journalPath: string, policy?: JournalMaintenancePolicy, now = Date.now()) {
  validateJournalMaintenance(policy);
  if (!policy) return { status: "disabled" as const };
  if (!Number.isFinite(now) || now < 0) throw new Error("Geçersiz bakım zamanı");
  const stats = journal.activeStorageStats(policy.maxActivePayloadBytes !== undefined, policy.maxActiveAgeHours !== undefined);
  const { activeEvents } = stats;
  const reasons: Array<"events" | "payload_bytes" | "age"> = [];
  if (policy.maxActiveEvents !== undefined && activeEvents >= policy.maxActiveEvents) reasons.push("events");
  if (policy.maxActivePayloadBytes !== undefined && stats.payloadBytes! >= policy.maxActivePayloadBytes) reasons.push("payload_bytes");
  if (policy.maxActiveAgeHours !== undefined) {
    if (stats.invalidEventTimes) throw new Error("Journal olay zamanı geçersiz; yaşa bağlı bakım uygulanamadı");
    if (stats.oldestEventAtMs != null && now - stats.oldestEventAtMs >= policy.maxActiveAgeHours * 3600000) reasons.push("age");
  }
  if (!activeEvents || !reasons.length) return { status: "below_threshold" as const, ...stats };
  // The engine rejects running tasks/inboxes/permissions before any archive is created.
  engine.checkpoint();
  const destination = join(dirname(journalPath), "archives", `journal-${Date.now()}-${randomUUID()}.sqlite`);
  return { status: "compacted" as const, ...stats, reasons, ...journal.compact(destination) };
}
