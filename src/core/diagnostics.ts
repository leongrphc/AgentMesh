import type { StoredEvent } from "./contracts.js";

/** Support reports deliberately omit all user/provider text, IDs, paths and sessions. */
export function diagnosticReport(events: readonly StoredEvent[]) {
  const counts: Record<string, number> = {};
  const known = new Set([
    "project.created", "project.parallelism.updated", "project.agents.configured", "task.created", "task.started", "task.completed", "task.failed",
    "permission.requested", "permission.resolved",
    "task.blocked", "task.interrupted", "task.cancelled", "task.retried", "task.session.saved",
    "task.worktree.prepared", "task.review.requested", "task.review.approved", "context.updated", "message.sent",
    "task.merge.conflicted", "task.merge.prepared",
  ]);
  for (const event of events) {
    const kind = known.has(event.payload.type) ? event.payload.type : "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return { version: 1, eventCount: events.length, counts };
}
