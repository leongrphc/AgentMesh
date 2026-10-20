import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { DesktopService } from "../src/desktop/service.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";

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
    assert.throws(() => service.contextHistory("other", workspaceRoot, key), /Proje değişti/);
    assert.throws(() => service.contextHistory(id, "wrong-root", key), /Proje değişti/);
    await service.close(); service.openDemo();
    assert.deepEqual(service.contextHistory(id, workspaceRoot, key), page);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
