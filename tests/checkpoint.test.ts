import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { MockAgent } from "../src/adapters/mock.js";

const persisted = (value: unknown) => JSON.parse(JSON.stringify(value));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mesh-checkpoint-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  const engine = new Orchestrator(journal);
  engine.createProject({ id: "p", workspaceRoot: root });
  engine.registerAgent(new MockAgent("a", ({ task }) => ({ summary: task.id, facts: [{ key: "decision", value: task.id }],
    messages: [{ to: "*", kind: "handoff", body: task.id }] })));
  engine.addTask({ id: "first", projectId: "p", agentId: "a", title: "First", instruction: "First", dependsOn: [], allowedPaths: [] });
  engine.addTask({ id: "second", projectId: "p", agentId: "a", title: "Second", instruction: "Second", dependsOn: ["first"], allowedPaths: [] });
  return { root, path, journal, engine, close: () => { journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("checkpoint restores all current state without replaying its prefix, then recovers only the tail", async () => {
  const f = fixture();
  try {
    await f.engine.run("p");
    const expected = persisted(f.engine.snapshot("p"));
    assert.equal(expected.contextConflicts[0]!.status, "pending");
    const checkpoint = f.engine.checkpoint();
    const scan = f.journal.scan.bind(f.journal);
    let replayed = 0;
    f.journal.scan = function* (projectId, after) { for (const event of scan(projectId, after)) { replayed++; yield event; } };
    let restored = new Orchestrator(f.journal);
    assert.equal(replayed, 0);
    assert.deepEqual(persisted(restored.snapshot("p")), expected);
    assert.deepEqual(restored.historyCounts("p"), f.engine.historyCounts("p"));
    restored.resolveContext("p", expected.contextConflicts[0]!.id, 1, "accept");
    const afterDecision = persisted(restored.snapshot("p"));
    replayed = 0;
    restored = new Orchestrator(f.journal);
    assert.equal(replayed, 2);
    assert.deepEqual(persisted(restored.snapshot("p")), afterDecision);
    assert.throws(() => f.engine.checkpoint(), /Journal değişti/);
    assert.equal(f.journal.loadCheckpoint()?.sequence, checkpoint.sequence);
    restored.checkpoint();
    f.journal.append({ type: "task.started", projectId: "p", taskId: "second" });
    f.journal.append({ type: "permission.requested", projectId: "p", taskId: "second", executionId: "crashed", requestId: "pending", provider: "mock", kind: "command", digest: "digest", expiresAt: "2026-01-01" });
    replayed = 0;
    const recovered = new Orchestrator(f.journal);
    assert.equal(replayed, 2);
    assert.equal(recovered.snapshot("p", false).tasks.find(task => task.id === "second")!.status, "needs_review");
    assert.ok(f.journal.recent("p").some(({ payload }) => payload.type === "permission.resolved" && payload.source === "restart"));
    recovered.checkpoint();
    replayed = 0;
    new Orchestrator(f.journal);
    assert.equal(replayed, 0);
  } finally { f.close(); }
});

test("bad checksum or projection format falls back cleanly and event edits invalidate cached state", () => {
  const f = fixture();
  try {
    const expected = persisted(f.engine.snapshot("p"));
    f.engine.checkpoint();
    const db = new DatabaseSync(f.path);
    try { db.exec("UPDATE replay_checkpoint SET digest = 'damaged'"); } finally { db.close(); }
    assert.equal(f.journal.loadCheckpoint(), undefined);
    assert.deepEqual(persisted(new Orchestrator(f.journal).snapshot("p")), expected);
    f.engine.checkpoint();
    const checkpoint = f.journal.loadCheckpoint()!;
    const invalid = JSON.parse(checkpoint.state);
    invalid.projects.push(["invented", { id: "invented", workspaceRoot: f.root }]);
    invalid.tasks[0][1].status = "invalid";
    f.journal.saveCheckpoint(JSON.stringify(invalid), checkpoint.sourceId);
    const fallback = new Orchestrator(f.journal);
    assert.deepEqual(persisted(fallback.snapshot("p")), expected);
    assert.throws(() => fallback.snapshot("invented"), /bulunamadı/);
    fallback.checkpoint();
    const edit = new DatabaseSync(f.path);
    try { edit.exec("UPDATE events SET at = '2026-01-01' WHERE sequence = 1"); } finally { edit.close(); }
    assert.equal(f.journal.loadCheckpoint(), undefined);
    assert.deepEqual(persisted(new Orchestrator(f.journal).snapshot("p")), expected);
    f.engine.checkpoint();
    const remove = new DatabaseSync(f.path);
    try { remove.exec("DELETE FROM events WHERE sequence = (SELECT MAX(sequence) FROM events)"); } finally { remove.close(); }
    assert.equal(f.journal.loadCheckpoint(), undefined);
    const remaining = persisted(new Orchestrator(f.journal).snapshot("p"));
    const drop = new DatabaseSync(f.path);
    try { drop.exec("DROP TABLE replay_checkpoint"); } finally { drop.close(); }
    assert.deepEqual(persisted(new Orchestrator(f.journal).snapshot("p")), remaining);
  } finally { f.close(); }
});

test("checkpoint creation is rejected during execution and remains usable after a clean completion", async () => {
  const f = fixture();
  try {
    f.engine.replaceAgent(new MockAgent("a", () => {
      assert.throws(() => f.engine.checkpoint(), /çalışan görevleri/);
      return { summary: "done" };
    }));
    await f.engine.run("p");
    f.engine.checkpoint();
    assert.deepEqual(persisted(new Orchestrator(f.journal).snapshot("p")), persisted(f.engine.snapshot("p")));
  } finally { f.close(); }
});
