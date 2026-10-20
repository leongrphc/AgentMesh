import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { DesktopService } from "../src/desktop/service.js";
import { diagnosticReport } from "../src/core/diagnostics.js";

test("SQLite stream preserves order and scope, freezes its upper bound and closes early iterators", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-stream-"));
  const journal = new SqliteJournal(join(root, "events.sqlite"));
  try {
    for (let i = 0; i < 250; i++) for (const projectId of ["p", "other"]) journal.append({ type: "project.parallelism.updated", projectId, maxParallel: i });
    const expected = journal.all();
    const scan = journal.scan("p")[Symbol.iterator]();
    assert.equal(scan.next().value!.payload.type, "project.parallelism.updated");
    journal.append({ type: "project.parallelism.updated", projectId: "p", maxParallel: 999 });
    const rest = [];
    for (let next = scan.next(); !next.done; next = scan.next()) rest.push(next.value);
    assert.equal(rest.length, 249);
    assert.deepEqual(rest, expected.filter(event => event.payload.type === "project.parallelism.updated" && event.payload.projectId === "p").slice(1));
    for (const _event of journal.scan()) break;
    journal.append({ type: "project.parallelism.updated", projectId: "p", maxParallel: 1000 });
    const recent = journal.recent("p");
    assert.equal(recent.length, 200);
    assert.deepEqual(recent, [...journal.scan("p")].slice(-200));
    assert.equal(journal.recent("missing").length, 0);
    for (const limit of [0, -1, 201, 1.5, NaN]) assert.throws(() => journal.recent("p", limit), /Geçersiz/);
    assert.equal(diagnosticReport(journal.scan("p")).eventCount, 252);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup uses one streamed replay and only writes recovery after the iterator closes", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-replay-"));
  const journal = new SqliteJournal(join(root, "events.sqlite"));
  try {
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    journal.append({ type: "task.created", task: { id: "t", projectId: "p", agentId: "a", title: "Task", instruction: "Task", allowedPaths: [], dependsOn: [] } });
    journal.append({ type: "task.started", projectId: "p", taskId: "t" });
    journal.append({ type: "permission.requested", projectId: "p", taskId: "t", executionId: "execution", requestId: "request", provider: "mock", kind: "command", digest: "digest", expiresAt: "2026-01-01" });
    journal.all = () => { throw new Error("Full read forbidden"); };
    const originalScan = journal.scan.bind(journal), originalAppend = journal.append.bind(journal);
    let scans = 0, active = false;
    journal.scan = function* () { scans++; active = true; try { yield* originalScan(); } finally { active = false; } };
    journal.append = event => { assert.equal(active, false); return originalAppend(event); };
    const engine = new Orchestrator(journal);
    assert.equal(scans, 1);
    assert.equal(engine.snapshot("p").tasks[0]!.status, "needs_review");
    assert.equal(engine.pendingPermissions("p").length, 0);
    const recovered = journal.recent("p");
    assert.ok(recovered.some(({ payload }) => payload.type === "permission.resolved" && payload.source === "restart"));
    const count = recovered.length;
    new Orchestrator(journal);
    assert.equal(journal.recent("p").length, count);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop opening and reopening never request an unbounded SQLite event array", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-open-stream-"));
  const service = new DesktopService(root);
  const original = SqliteJournal.prototype.all;
  SqliteJournal.prototype.all = () => { throw new Error("Full read forbidden"); };
  try {
    service.openDemo(); service.setParallelism(3);
    await service.close();
    assert.equal(service.openDemo().maxParallel, 3);
    assert.ok(service.state().events.length <= 200);
  } finally {
    SqliteJournal.prototype.all = original;
    await service.close(); rmSync(root, { recursive: true, force: true });
  }
});
