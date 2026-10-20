import type { ContextConflict, ContextPackage, Fact } from "./contracts.js";
import { eventStream, type EventStore } from "./journal.js";

/** Explicit full exports only; live snapshots and scheduling must use compact state. */
export function materializeHistory(store: EventStore, projectId: string) {
  const facts = new Map<string, Fact[]>();
  const conflicts = new Map<string, ContextConflict>();
  const packages = new Map<string, ContextPackage[]>();
  for (const { payload: event } of eventStream(store, projectId)) {
    if (event.type === "context.updated") {
      const versions = facts.get(event.fact.key) ?? [];
      versions.push({ ...event.fact, revision: versions.length + 1 });
      facts.set(event.fact.key, versions);
    } else if (event.type === "task.context.prepared") {
      const entries = packages.get(event.taskId) ?? [];
      entries.push(event.package); packages.set(event.taskId, entries);
    } else if (event.type === "context.conflict.created") {
      conflicts.set(event.conflict.id, structuredClone(event.conflict));
    } else if (event.type === "context.conflict.resolved") {
      const conflict = conflicts.get(event.conflictId);
      if (!conflict) throw new Error("Context çözümünün kaynak önerisi bulunamadı");
      conflict.status = "resolved";
      conflict.resolution = { choice: event.choice, revision: event.revision, at: event.at };
    }
  }
  return { facts: Object.fromEntries(facts), conflicts: [...conflicts.values()], packages };
}
