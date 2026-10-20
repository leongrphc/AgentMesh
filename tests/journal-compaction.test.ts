import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { verifyJournalArchive } from "../src/core/journal-archive.js";
import { DesktopService } from "../src/desktop/service.js";

test("rotation shrinks the active journal while preserving checkpoints, pages, replay and subsequent writes", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-compact-"));
  const path = join(root, "events.sqlite"), archive = join(root, "archive.sqlite");
  let journal = new SqliteJournal(path);
  try {
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    journal.append({ type: "task.created", task: { id: "t", projectId: "p", agentId: "a", title: "Task", instruction: "Task", allowedPaths: [], dependsOn: [] } });
    for (let i = 0; i < 200; i++) journal.append({ type: "context.updated", projectId: "p",
      fact: { key: "contract", value: `${i}:` + "x".repeat(4096), sourceTaskId: "t", updatedAt: "2026-01-01" } });
    for (let i = 0; i < 25; i++) journal.append({ type: "task.context.prepared", projectId: "p", taskId: "t",
      package: { policyVersion: 1, executionId: String(i), bytes: 2, digest: "a".repeat(64), entries: [] } });
    journal.append({ type: "context.conflict.created", projectId: "p", conflict: { id: "pending", key: "contract", baseRevision: 200, status: "pending",
      proposal: { key: "contract", value: "tail", sourceTaskId: "t", updatedAt: "2026-01-01" } } });
    const before = journal.all();
    const engine = new Orchestrator(journal); engine.checkpoint();
    const snapshot = engine.snapshot("p");
    journal.close();
    const originalBytes = statSync(path).size;
    journal = new SqliteJournal(path);
    const compact = journal.compact(archive);
    assert.equal(compact.vacuumed, true, compact.maintenanceError);
    const raw = (journal as unknown as { db: DatabaseSync }).db;
    assert.throws(() => raw.exec("DELETE FROM history0.events"), /readonly|read-only/i);
    assert.deepEqual(journal.all(), before);
    assert.deepEqual(new Orchestrator(journal).snapshot("p"), snapshot);
    assert.equal(journal.contextHistoryPage("p", "contract", 181).entries[0]!.revision, 180);
    const physical = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(physical.prepare("SELECT COUNT(*) AS n FROM events").get()!.n, 0);
      assert.equal(physical.prepare("PRAGMA user_version").get()!.user_version, 3);
    } finally { physical.close(); }
    assert.ok(statSync(path).size < originalBytes / 2);
    journal.append({ type: "context.updated", projectId: "p", fact: { key: "contract", value: "tail", sourceTaskId: "t", updatedAt: "2026-01-02" } });
    journal.append({ type: "context.conflict.resolved", projectId: "p", conflictId: "pending", revision: 201, choice: "accept", at: "2026-01-02" });
    journal.append({ type: "task.context.prepared", projectId: "p", taskId: "t", package: { policyVersion: 1, executionId: "tail", bytes: 2, digest: "a".repeat(64), entries: [] } });
    assert.equal(journal.all().length, before.length + 3);
    assert.equal(journal.resolvedContextPage("p").entries[0]!.proposal.value, "tail");
    assert.equal(journal.contextPackagesPage("p", "t").entries[0]!.executionId, "tail");
    assert.equal(journal.contextPackagesPage("p", "t", 2).entries[0]!.executionId, "0");
    assert.equal(journal.contextHistoryPage("p", "contract").latestRevision, 201);
    const tail = new Orchestrator(journal).snapshot("p");
    assert.equal(tail.context.contract?.value, "tail");
    const secondArchive = join(root, "archive-2.sqlite");
    journal.compact(secondArchive);
    journal.close();
    journal = new SqliteJournal(path);
    assert.deepEqual(new Orchestrator(journal).snapshot("p"), tail);
    assert.equal(verifyJournalArchive(archive).eventCount, before.length);
    assert.equal(verifyJournalArchive(secondArchive).eventCount, before.length + 3);
    const exported = join(root, "export.sqlite");
    journal.archive(exported);
    assert.equal(verifyJournalArchive(exported).eventCount, before.length + 3);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed rotation rolls back its link and deletion; an open replay cursor prevents rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-rotation-rollback-"));
  const path = join(root, "events.sqlite"), archive = join(root, "archive.sqlite");
  const journal = new SqliteJournal(path);
  try {
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    const before = journal.all();
    const cursor = journal.scan()[Symbol.iterator](); cursor.next();
    assert.throws(() => journal.compact(archive), /taraması/);
    cursor.return?.();
    const inject = new DatabaseSync(path);
    try { inject.exec("CREATE TRIGGER fail_rotation BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'injected rotation failure'); END;"); }
    finally { inject.close(); }
    assert.throws(() => journal.compact(archive), /injected rotation failure/);
    assert.deepEqual(journal.all(), before);
    assert.equal(verifyJournalArchive(archive).eventCount, 1);
    const inspect = new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare("PRAGMA user_version").get()!.user_version, 2);
      assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM journal_archive").get()!.n, 0);
      inspect.exec("DROP TRIGGER fail_rotation");
    } finally { inspect.close(); }
    assert.equal(journal.compact(join(root, "second.sqlite")).compacted, true);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("missing or changed linked archives fail opening and release the journal lock", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-linked-"));
  const path = join(root, "events.sqlite"), archive = join(root, "archive.sqlite");
  const journal = new SqliteJournal(path);
  try {
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    journal.compact(archive); journal.close();
    const moved = join(root, "moved.sqlite"); renameSync(archive, moved);
    assert.throws(() => new SqliteJournal(path));
    renameSync(moved, archive);
    const reopened = new SqliteJournal(path); assert.equal(reopened.all().length, 1); reopened.close();
    const tamper = new DatabaseSync(archive); tamper.exec("UPDATE events SET at = 'changed'"); tamper.close();
    assert.throws(() => new SqliteJournal(path), /doğrulaması başarısız/);
    assert.throws(() => new SqliteJournal(path), /doğrulaması başarısız/);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop reopens a compacted journal and persists new task and settings events in its active tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-compact-desktop-"));
  const service = new DesktopService(root);
  try {
    const initial = service.openDemo(); await service.close();
    const journal = new SqliteJournal(join(root, "demo.sqlite"));
    try {
      journal.append({ type: "context.updated", projectId: initial.snapshot.project.id,
        fact: { key: "decision", value: "archived", sourceTaskId: "plan", updatedAt: "2026-01-01" } });
      new Orchestrator(journal).checkpoint();
      journal.compact(join(root, "history.sqlite"));
    } finally { journal.close(); }
    const state = service.openDemo();
    assert.equal(state.snapshot.context.decision?.value, "archived");
    service.createTask({ id: "after-archive", title: "Task", instruction: "Task", agentId: state.agents[0]!.id, dependsOn: ["plan"], allowedPaths: ["src/**"] });
    service.setParallelism(4); await service.close();
    const reopened = service.openDemo();
    assert.equal(reopened.maxParallel, 4);
    assert.ok(reopened.snapshot.tasks.some(task => task.id === "after-archive"));
    assert.equal(service.contextHistory(reopened.snapshot.project.id, reopened.snapshot.project.workspaceRoot, "decision").entries[0]!.value, "archived");
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
