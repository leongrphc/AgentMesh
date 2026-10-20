import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { DesktopService } from "../src/desktop/service.js";

test("message pages preserve scope and stable cursors, bound fan-out receipts and survive checkpoint rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-message-pages-"));
  const journal = new SqliteJournal(join(root, "events.sqlite"));
  try {
    for (const id of ["p", "other"]) journal.append({ type: "project.created", project: { id, workspaceRoot: root } });
    for (let i = 0; i < 56; i++) journal.append({ type: "task.created", task: { id: `t${i}`, projectId: i === 55 ? "other" : "p",
      agentId: i === 0 ? "a" : "b", title: "Task", instruction: "Task", dependsOn: [], allowedPaths: [] } });
    for (let i = 0; i < 47; i++) journal.append({ type: "message.sent", projectId: "p", message: {
      id: `m${i}`, projectId: "p", taskId: i % 7 === 0 ? "t0" : "@user", from: "@user", to: ["a", "b", "*"][i % 3]!,
      kind: "progress", body: `body ${i}`, createdAt: "2026-01-01",
    } });
    for (let i = 0; i < 56; i++) journal.append({ type: "message.delivery", projectId: i === 55 ? "other" : "p", delivery: {
      taskId: `t${i}`, messageId: "m46", executionId: "e", status: "accepted", mode: "live",
    } });
    let engine = new Orchestrator(journal);
    const first = engine.messageHistoryPage("p");
    assert.equal(first.entries.length, 20);
    assert.equal(first.entries[0]!.deliveryCount, 55);
    assert.equal(first.entries[0]!.deliveries.length, 50);
    assert.equal(engine.messageHistoryPage("p", "t54").entries[0]!.deliveries[0]!.taskId, "t54");
    assert.ok(engine.messageHistoryPage("p", "t0").entries.every(({ message }) => message.taskId === "t0" || message.to === "a" || message.to === "*"));
    assert.throws(() => engine.messageHistoryPage("p", "t55"), /başka projeye/);
    assert.equal(engine.messageHistoryPage("other").total, 0);
    assert.deepEqual(engine.snapshot("p", false).messages, []);
    assert.deepEqual(engine.snapshot("p", false).deliveries, []);
    assert.equal(engine.snapshot("p").messages.length, 47);
    const revision = engine.historyCounts("p").messageRevision;
    journal.append({ type: "message.sent", projectId: "p", message: { id: "new", projectId: "p", taskId: "@user", from: "@user", to: "*", kind: "progress", body: "new", createdAt: "2026-01-02" } });
    engine = new Orchestrator(journal);
    assert.notEqual(engine.historyCounts("p").messageRevision, revision);
    const second = engine.messageHistoryPage("p", undefined, first.nextBefore);
    const third = engine.messageHistoryPage("p", undefined, second.nextBefore);
    assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map(entry => entry.message.id), Array.from({ length: 47 }, (_, i) => `m${46 - i}`));
    first.entries[0]!.message.body = "mutated";
    assert.equal(engine.messageHistoryPage("p").entries[1]!.message.body, "body 46");
    engine.checkpoint(); journal.compact(join(root, "archive.sqlite"));
    assert.deepEqual(new Orchestrator(journal).messageHistoryPage("p"), engine.messageHistoryPage("p"));
    assert.throws(() => engine.messageHistoryPage("p", undefined, 0), /Geçersiz/);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop sends remain idempotent while snapshots omit message bodies and lazy reads enforce workspace scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-message-ui-"));
  const service = new DesktopService(root);
  try {
    const initial = service.openDemo();
    const { id, workspaceRoot } = initial.snapshot.project;
    const draft = { to: "*", kind: "progress" as const, body: "persistent message", idempotencyKey: "one" };
    const messageId = service.sendMessage(draft);
    assert.equal(service.sendMessage(draft), messageId);
    assert.equal(service.state().historyCounts.messages, 1);
    assert.deepEqual(service.state().snapshot.messages, []);
    assert.equal(service.messageHistory(id, workspaceRoot).entries[0]!.message.id, messageId);
    assert.throws(() => service.messageHistory(id, "wrong-root"), /Proje değişti/);
    assert.throws(() => service.messageHistory(id, workspaceRoot, "missing"), /Geçersiz|bulunamadı/);
    await service.close(); service.openDemo();
    assert.equal(service.messageHistory(id, workspaceRoot).entries[0]!.message.body, draft.body);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
