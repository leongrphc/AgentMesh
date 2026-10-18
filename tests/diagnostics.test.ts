import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticReport } from "../src/core/diagnostics.js";
import type { StoredEvent } from "../src/core/contracts.js";

test("support export excludes historical free text, paths and identity without mutating state", () => {
  const events: StoredEvent[] = [{ id: "secret-id", at: "secret-time", payload: {
    type: "task.failed", projectId: "private-project", taskId: "private-task", error: "arbitrary secret without recognizable format",
  } }];
  const before = JSON.stringify(events);
  assert.deepEqual(diagnosticReport(events), { version: 1, eventCount: 1, counts: { "task.failed": 1 } });
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(diagnosticReport([]), { version: 1, eventCount: 0, counts: {} });
});
