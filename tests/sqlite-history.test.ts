import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "../src/core/journal.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import type { DomainEvent } from "../src/core/contracts.js";

test("indexed SQLite history matches replay pages, including interleaved projects and late resolutions", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-sql-pages-"));
  const path = join(root, "events.sqlite");
  let db = new SqliteJournal(path);
  try {
    const memory = new Journal(join(root, "events.jsonl"));
    const append = (event: DomainEvent) => { db.append(event); memory.append(event); };
    for (const projectId of ["p", "other"]) {
      append({ type: "project.created", project: { id: projectId, workspaceRoot: root } });
      append({ type: "task.created", task: { id: projectId, projectId, agentId: "a", title: "Task", instruction: "Task", dependsOn: [], allowedPaths: ["src/**"] } });
    }
    for (let i = 1; i <= 47; i++) for (const projectId of ["p", "other"]) {
      append({ type: "context.updated", projectId, fact: { key: "contract' OR 1=1 --", value: `${projectId}:${i}`, sourceTaskId: projectId, updatedAt: "2026-01-01", revision: 999 } });
      append({ type: "context.conflict.created", projectId, conflict: { id: String(i), key: "contract", baseRevision: i, status: "pending",
        proposal: { key: "contract", value: `${projectId}:${i}`, sourceTaskId: projectId, updatedAt: "2026-01-01" } } });
      append({ type: "task.context.prepared", projectId, taskId: projectId, package: { policyVersion: 1, executionId: `${projectId}:${i}`, digest: "a".repeat(64), bytes: 2, entries: [] } });
    }
    for (let i = 47; i >= 1; i--) for (const projectId of ["p", "other"]) append({ type: "context.conflict.resolved", projectId,
      conflictId: String(i), revision: 47, choice: "keep", at: "2026-01-02" });
    const beforeOpen = db.all();
    db.close();
    // Simulate an existing schema-v2 database without the new derived indexes.
    const old = new DatabaseSync(path);
    old.exec("DROP INDEX events_history_type; DROP INDEX events_history_fact; DROP INDEX events_history_task; DROP INDEX events_history_conflict;"); old.close();
    db = new SqliteJournal(path);
    assert.deepEqual(db.all(), beforeOpen);
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      for (const [type, field, index] of [["context.updated", "fact.key", "events_history_fact"], ["task.context.prepared", "taskId", "events_history_task"], ["context.conflict.resolved", "", "events_history_type"]]) {
        const query = `EXPLAIN QUERY PLAN SELECT payload FROM events WHERE project_id = 'p' AND json_extract(payload, '$.type') = '${type}'${field ? ` AND json_extract(payload, '$.${field}') = 'p'` : ""} ORDER BY sequence DESC LIMIT 20`;
        const plan = JSON.stringify(inspect.prepare(query).all());
        assert.ok(plan.includes(index!), plan);
        assert.doesNotMatch(plan, /TEMP B-TREE/);
      }
    } finally { inspect.close(); }
    const diskEngine = new Orchestrator(db), replayEngine = new Orchestrator(memory);
    db.all = () => { throw new Error("History reads must not reload all events"); };
    for (const projectId of ["p", "other"]) for (const before of [undefined, 48, 28, 8, 1, 200]) {
      assert.deepEqual(diskEngine.contextHistoryPage(projectId, "contract' OR 1=1 --", before), replayEngine.contextHistoryPage(projectId, "contract' OR 1=1 --", before));
      assert.deepEqual(diskEngine.resolvedContextPage(projectId, before), replayEngine.resolvedContextPage(projectId, before));
      assert.deepEqual(diskEngine.contextPackagesPage(projectId, projectId, before), replayEngine.contextPackagesPage(projectId, projectId, before));
    }
    const page = diskEngine.resolvedContextPage("p");
    page.entries[0]!.proposal.value = "mutated";
    assert.equal(diskEngine.resolvedContextPage("p").entries[0]!.proposal.value, "p:1");
    assert.equal(db.contextHistoryPage("p", "missing").entries.length, 0);
    for (const before of [0, -1, 0.5, NaN, Infinity]) {
      assert.throws(() => db.contextHistoryPage("p", "key", before), /Geçersiz/);
      assert.throws(() => db.contextPackagesPage("p", "p", before), /Geçersiz/);
      assert.throws(() => db.resolvedContextPage("p", before), /Geçersiz/);
    }
    const valid: DomainEvent = { type: "context.updated", projectId: "p", fact: { key: "rollback", value: "test", sourceTaskId: "p", updatedAt: "2026-01-01" } };
    assert.throws(() => db.appendBatch([valid, { ...valid, projectId: null } as unknown as DomainEvent]));
    assert.equal(db.contextHistoryPage("p", "rollback").latestRevision, 0);
    db.close();
    assert.throws(() => db.resolvedContextPage("p"), /kapalı/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
