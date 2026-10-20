import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Orchestrator } from "./orchestrator.js";
import type { SqliteJournal } from "./sqlite-journal.js";

export interface JournalMaintenancePolicy {
  maxActiveEvents?: number;
  maxActivePayloadBytes?: number;
  maxActiveAgeHours?: number;
  keepManagedArchives?: number;
}

const limits = {
  maxActiveEvents: [100, 10000000],
  maxActivePayloadBytes: [1024, 1024 ** 4],
  maxActiveAgeHours: [1, 87600],
  keepManagedArchives: [1, 1000],
} as const;

export function validateJournalMaintenance(value: JournalMaintenancePolicy | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.keys(value).some(key => key !== "keepManagedArchives") || Object.keys(value).some(key => !Object.hasOwn(limits, key))) {
    throw new Error("journalMaintenance için en az bir geçerli olay, içerik boyutu veya yaş eşiği gerekli");
  }
  for (const key of Object.keys(value) as Array<keyof JournalMaintenancePolicy>) {
    const number = value[key];
    const [min, max] = limits[key];
    if (!Number.isSafeInteger(number) || number! < min || number! > max) throw new Error(`journalMaintenance.${key} ${min}-${max} aralığında olmalı`);
  }
}

/** Opt-in, idle-boundary rotation. Retired managed copies can be pruned only with an explicit policy. */
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
  const directory = join(dirname(journalPath), "archives");
  const prune = () => policy.keepManagedArchives === undefined ? undefined : journal.pruneManagedArchives(directory, policy.keepManagedArchives);
  if (!activeEvents || !reasons.length) {
    if (policy.keepManagedArchives !== undefined) engine.checkpoint();
    return { status: "below_threshold" as const, ...stats, retention: prune() };
  }
  // The engine rejects running tasks/inboxes/permissions before any archive is created.
  engine.checkpoint();
  const destination = join(directory, `journal-${Date.now()}-${randomUUID()}.sqlite`);
  const compacted = journal.compact(destination, true);
  let retention;
  try { retention = prune(); }
  catch (error) { retention = { removed: 0, errors: [String(error)] }; }
  return { status: "compacted" as const, ...stats, reasons, ...compacted, retention };
}
