import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Orchestrator } from "./orchestrator.js";
import type { SqliteJournal } from "./sqlite-journal.js";

export interface JournalMaintenancePolicy { maxActiveEvents: number }

export function validateJournalMaintenance(value: JournalMaintenancePolicy | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => key !== "maxActiveEvents")
    || !Number.isSafeInteger(value.maxActiveEvents) || value.maxActiveEvents < 100 || value.maxActiveEvents > 10000000) {
    throw new Error("journalMaintenance.maxActiveEvents 100-10000000 aralığında olmalı");
  }
}

/** Opt-in, idle-boundary rotation. Archives are required history, never automatically deleted. */
export function maintainJournal(journal: SqliteJournal, engine: Orchestrator, journalPath: string, policy?: JournalMaintenancePolicy) {
  validateJournalMaintenance(policy);
  if (!policy) return { status: "disabled" as const };
  const activeEvents = journal.activeEventCount();
  if (activeEvents < policy.maxActiveEvents) return { status: "below_threshold" as const, activeEvents };
  // The engine rejects running tasks/inboxes/permissions before any archive is created.
  engine.checkpoint();
  const destination = join(dirname(journalPath), "archives", `journal-${Date.now()}-${randomUUID()}.sqlite`);
  return { status: "compacted" as const, activeEvents, ...journal.compact(destination) };
}
