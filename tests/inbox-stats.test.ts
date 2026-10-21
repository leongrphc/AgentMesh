import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import type { MessageDelivery } from "../src/core/contracts.js";

test("SQLite inbox aggregates preserve gaps, scope and latest receipts across archives without transferring history", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-inbox-stats-"));
  const journal = new SqliteJournal(join(root, "events.sqlite"));
  try {
    for (const id of ["p", "other"]) journal.append({ type: "project.created", project: { id, workspaceRoot: root } });
    for (const id of ["t", "t2", "foreign"]) journal.append({ type: "task.created", task: { id, projectId: id === "foreign" ? "other" : "p",
      agentId: "a", title: id, instruction: id, dependsOn: [], allowedPaths: [] } });
    for (let i = 0; i < 8; i++) journal.append({ type: "message.sent", projectId: i === 7 ? "other" : "p", message: {
      id: `m${i}`, projectId: i === 7 ? "other" : "p", taskId: i === 5 ? "t" : "@user", from: "@user",
      to: i === 6 ? "b" : i % 2 ? "*" : "a", kind: "progress", body: `message ${i}`, createdAt: "2026-10-21",
    } });
    const receipt = (id: number, status: MessageDelivery["status"], taskId = "t") => journal.append({ type: "message.delivery", projectId: "p",
      delivery: { messageId: `m${id}`, taskId, executionId: "e", status, mode: "prompt" } });
    receipt(0, "accepted"); receipt(2, "accepted"); receipt(3, "accepted"); receipt(3, "uncertain"); receipt(4, "queued"); receipt(0, "queued", "t2");
    const compare = () => {
      const events = journal.all();
      const fallback = new Orchestrator({ all: () => events, append: () => { throw new Error("unexpected write"); }, appendBatch: () => { throw new Error("unexpected write"); } });
      const engine = new Orchestrator(journal);
      for (const project of ["p", "other"]) assert.deepEqual(engine.snapshot(project, false).inboxes, fallback.snapshot(project, false).inboxes);
    };
    compare();
    assert.deepEqual(journal.inboxStats("p", "t", "a"), { cursor: 1, pending: 3, uncertain: 1 });
    assert.deepEqual(journal.inboxStats("p", "t2", "a"), { cursor: 0, pending: 6, uncertain: 0 });
    assert.deepEqual(journal.inboxStats("other", "foreign", "a"), { cursor: 0, pending: 1, uncertain: 0 });
    assert.deepEqual(journal.inboxStats("missing", "none", "a"), { cursor: 0, pending: 0, uncertain: 0 });
    new Orchestrator(journal).checkpoint(); journal.compact(join(root, "archive.sqlite"));
    receipt(1, "accepted"); receipt(3, "accepted");
    compare();
    assert.deepEqual(journal.inboxStats("p", "t", "a"), { cursor: 4, pending: 1, uncertain: 0 });
    const engine = new Orchestrator(journal);
    journal.scanMessageReferences = () => { throw new Error("Message history transferred for counters"); };
    journal.scanDeliveries = () => { throw new Error("Delivery history transferred for counters"); };
    journal.readDelivery = () => { throw new Error("Individual receipt read for counters"); };
    assert.deepEqual(engine.snapshot("p", false).inboxes[0], { taskId: "t", cursor: 4, pending: 1, uncertain: 0 });
    receipt(4, "accepted");
    assert.deepEqual(journal.inboxStats("p", "t", "a"), { cursor: 5, pending: 0, uncertain: 0 });
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});
