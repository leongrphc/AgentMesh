import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { DesktopService } from "../src/desktop/service.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";

test("resolved decisions and execution packages use stable append order and compact snapshots retain pending decisions", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-audit-page-"));
  try {
    const journal = new Journal(join(root, "events.jsonl"));
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    journal.append({ type: "project.created", project: { id: "other", workspaceRoot: root } });
    journal.append({ type: "task.created", task: { id: "task", projectId: "p", agentId: "agent", title: "Task", instruction: "Task", dependsOn: [], allowedPaths: ["src/**"] } });
    for (let i = 0; i <= 45; i++) journal.append({ type: "context.conflict.created", projectId: "p", conflict: {
      id: `c${i}`, key: "decision", status: "pending", baseRevision: 1,
      proposal: { key: "decision", value: String(i), sourceTaskId: "task", updatedAt: "2026-01-01" },
    } });
    const append = (i: number) => {
      journal.append({ type: "context.conflict.resolved", projectId: "p", conflictId: `c${i}`, choice: "keep", revision: 1, at: "2026-01-01" });
      journal.append({ type: "task.context.prepared", projectId: "p", taskId: "task", package: { policyVersion: 1, executionId: `e${i}`, digest: "a".repeat(64), bytes: 2, entries: [] } });
    };
    for (let i = 1; i <= 45; i++) append(i);
    let engine = new Orchestrator(journal);
    const first = engine.resolvedContextPage("p");
    assert.equal(first.entries.length, 20);
    assert.equal(first.entries[0]!.id, "c45");
    assert.equal(engine.contextPackagesPage("p", "task").entries[0]!.executionId, "e45");
    assert.deepEqual(engine.snapshot("p", false).contextConflicts.map(entry => entry.id), ["c0"]);
    assert.equal(engine.snapshot("p", false).tasks[0]!.contextPackages, undefined);
    assert.deepEqual(engine.historyCounts("p"), { resolvedDecisions: 45, contextPackages: { task: 45 } });
    append(0); // Oldest proposal is resolved last, so it must append rather than shift older pages.
    engine = new Orchestrator(journal);
    const second = engine.resolvedContextPage("p", first.nextBefore);
    assert.equal(second.entries[0]!.id, "c25");
    assert.equal(engine.resolvedContextPage("p").entries[0]!.id, "c0");
    assert.equal(engine.contextPackagesPage("p", "task", first.nextBefore).entries[0]!.executionId, "e25");
    second.entries[0]!.proposal.value = "mutated";
    assert.equal(engine.resolvedContextPage("p", first.nextBefore).entries[0]!.proposal.value, "25");
    assert.equal(engine.snapshot("p").tasks[0]!.contextPackages!.length, 46);
    assert.equal(engine.resolvedContextPage("other").total, 0);
    assert.throws(() => engine.contextPackagesPage("other", "task"), /başka projeye/);
    for (const before of [0, -1, 0.5, NaN, Infinity]) {
      assert.throws(() => engine.resolvedContextPage("p", before), /Geçersiz/);
      assert.throws(() => engine.contextPackagesPage("p", "task", before), /Geçersiz/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("history cursors traverse newest first without gaps when new revisions arrive", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-history-"));
  try {
    const journal = new Journal(join(root, "events.jsonl"));
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    journal.append({ type: "project.created", project: { id: "other", workspaceRoot: root } });
    for (let i = 1; i <= 45; i++) journal.append({ type: "context.updated", projectId: "p", fact: {
      key: "decision", value: `value ${i}`, sourceTaskId: "source", updatedAt: "2026-01-01",
    } });
    let engine = new Orchestrator(journal);
    const first = engine.contextHistoryPage("p", "decision");
    assert.equal(first.entries.length, 20);
    assert.deepEqual(first.entries.map(entry => entry.revision), Array.from({ length: 20 }, (_, i) => 45 - i));
    assert.equal(first.nextBefore, 26);
    journal.append({ type: "context.updated", projectId: "p", fact: { key: "decision", value: "new", sourceTaskId: "source", updatedAt: "2026-01-02" } });
    engine = new Orchestrator(journal);
    const second = engine.contextHistoryPage("p", "decision", first.nextBefore);
    const third = engine.contextHistoryPage("p", "decision", second.nextBefore);
    assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map(entry => entry.revision), Array.from({ length: 45 }, (_, i) => 45 - i));
    assert.equal(third.nextBefore, undefined);
    assert.equal(second.latestRevision, 46);
    first.entries[0]!.value = "external mutation";
    assert.equal(engine.contextHistoryPage("p", "decision", 46).entries[0]!.value, "value 45");
    assert.equal(engine.contextHistoryPage("p", "decision", 1).entries.length, 0);
    assert.equal(engine.contextHistoryPage("p", "missing").entries.length, 0);
    assert.equal(engine.contextHistoryPage("other", "decision").entries.length, 0);
    assert.deepEqual(engine.snapshot("p", false).contextHistory, {});
    assert.equal(engine.snapshot("p").contextHistory.decision?.length, 46);
    for (const before of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => engine.contextHistoryPage("p", "decision", before), /Geçersiz/);
    assert.throws(() => engine.contextHistoryPage("foreign", "decision"), /Proje/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("desktop broadcasts omit revision history and scoped lazy reads survive reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-history-desktop-"));
  const service = new DesktopService(root);
  try {
    const initial = service.openDemo();
    await service.close();
    const journal = new SqliteJournal(join(root, "demo.sqlite"));
    try {
      for (let i = 0; i < 45; i++) journal.append({ type: "context.updated", projectId: initial.snapshot.project.id,
        fact: { key: "decision", value: `value ${i}`, sourceTaskId: "plan", updatedAt: "2026-01-01" } });
      journal.append({ type: "task.context.prepared", projectId: initial.snapshot.project.id, taskId: "plan", package: {
        policyVersion: 1, executionId: "attempt", digest: "a".repeat(64), bytes: 2, entries: [],
      } });
      journal.append({ type: "context.conflict.created", projectId: initial.snapshot.project.id, conflict: {
        id: "resolved", key: "decision", baseRevision: 45, status: "pending",
        proposal: { key: "decision", value: "alternative", sourceTaskId: "plan", updatedAt: "2026-01-01" },
      } });
      journal.append({ type: "context.conflict.resolved", projectId: initial.snapshot.project.id,
        conflictId: "resolved", choice: "keep", revision: 45, at: "2026-01-01" });
    } finally { journal.close(); }
    service.openDemo();
    const state = service.state();
    const key = Object.keys(state.snapshot.context)[0]!;
    const { id, workspaceRoot } = state.snapshot.project;
    assert.ok(key);
    assert.deepEqual(state.snapshot.contextHistory, {});
    const page = service.contextHistory(id, workspaceRoot, key);
    assert.equal(page.entries.length, 20);
    assert.equal(page.latestRevision, 45);
    assert.equal(state.historyCounts.resolvedDecisions, 1);
    assert.equal(state.historyCounts.contextPackages.plan, 1);
    assert.deepEqual(state.snapshot.contextConflicts, []);
    assert.equal(state.snapshot.tasks[0]!.contextPackages, undefined);
    assert.equal(service.resolvedContext(id, workspaceRoot).entries[0]!.id, "resolved");
    assert.equal(service.contextPackages(id, workspaceRoot, "plan").entries[0]!.executionId, "attempt");
    assert.throws(() => service.resolvedContext(id, "wrong-root"), /Proje değişti/);
    assert.throws(() => service.contextPackages("other", workspaceRoot, "plan"), /Proje değişti/);
    assert.throws(() => service.contextHistory("other", workspaceRoot, key), /Proje değişti/);
    assert.throws(() => service.contextHistory(id, "wrong-root", key), /Proje değişti/);
    await service.close(); service.openDemo();
    assert.deepEqual(service.contextHistory(id, workspaceRoot, key), page);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
