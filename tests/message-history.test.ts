import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { DesktopService } from "../src/desktop/service.js";
import { MockAgent } from "../src/adapters/mock.js";

test("SQLite retains message references without bodies and reads only requested content across checkpoint and archive", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-message-storage-"));
  const journal = new SqliteJournal(join(root, "events.sqlite"));
  try {
    let engine = new Orchestrator(journal);
    engine.createProject({ id: "p", workspaceRoot: root });
    const body = "retained-only-on-disk:" + "x".repeat(8000);
    for (let i = 0; i < 120; i++) engine.sendMessage("p", { to: "*", kind: "progress", body, idempotencyKey: `key-${i}` });
    engine.checkpoint();
    const checkpoint = journal.loadCheckpoint()!;
    assert.ok(!checkpoint.state.includes(body));
    assert.ok(Buffer.byteLength(checkpoint.state) < 60000);
    let reads = 0;
    const read = journal.readEvent.bind(journal);
    journal.readEvent = id => { reads++; return read(id); };
    engine = new Orchestrator(journal);
    engine.snapshot("p", false);
    assert.equal(reads, 0);
    assert.equal(engine.messageHistoryPage("p").entries[0]!.message.body, body);
    assert.equal(reads, 20);
    journal.compact(join(root, "archive.sqlite"));
    engine = new Orchestrator(journal);
    const original = engine.messageHistoryPage("p").entries[0]!.message;
    assert.equal(engine.sendMessage("p", { to: "*", kind: "progress", body, idempotencyKey: "key-119" }), original.id);
    assert.throws(() => engine.sendMessage("p", { to: "*", kind: "progress", body: "changed", idempotencyKey: "key-119" }), /farklı içerik/);
    assert.equal(engine.snapshot("p").messages.length, 120);
    // Old projection versions must replay authoritative events instead of interpreting stale shapes.
    const old = JSON.parse(checkpoint.state); old.version = 1;
    journal.saveCheckpoint(JSON.stringify(old), checkpoint.sourceId);
    assert.equal(new Orchestrator(journal).snapshot("p").messages[0]!.body, body);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disk-backed inbox hydrates bounded prompt messages and then delivers the remaining and new live messages", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-message-delivery-"));
  const journal = new SqliteJournal(join(root, "events.sqlite"));
  try {
    const engine = new Orchestrator(journal);
    engine.createProject({ id: "p", workspaceRoot: root });
    engine.registerAgent(new MockAgent("a", async input => {
      assert.deepEqual(input.inbox.map(message => message.body), Array.from({ length: 64 }, (_, i) => `message ${i}`));
      const received: string[] = [];
      let done!: () => void;
      const delivered = new Promise<void>(resolve => { done = resolve; });
      const stop = input.subscribeInbox!(async message => {
        received.push(message.body);
        if (received.length === 7) done();
        return true;
      });
      engine.sendMessage("p", { to: "a", kind: "progress", body: "new live", idempotencyKey: "live" });
      await delivered; await stop();
      assert.deepEqual(received, [...Array.from({ length: 6 }, (_, i) => `message ${i + 64}`), "new live"]);
      return { summary: "delivered" };
    }));
    engine.addTask({ id: "t", projectId: "p", agentId: "a", title: "Task", instruction: "Task", dependsOn: [], allowedPaths: [] });
    for (let i = 0; i < 70; i++) engine.sendMessage("p", { to: "a", kind: "progress", body: `message ${i}`, idempotencyKey: `key-${i}` });
    const result = await engine.run("p");
    assert.equal(result.tasks[0]!.status, "completed");
    assert.equal(result.inboxes[0]!.cursor, 71);
    engine.checkpoint();
    assert.deepEqual(JSON.parse(journal.loadCheckpoint()!.state).deliveries, []);
    journal.compact(join(root, "accepted.sqlite"));
    assert.deepEqual(new Orchestrator(journal).snapshot("p").deliveries, result.deliveries);
    const first = result.deliveries[0]!;
    journal.append({ type: "message.delivery", projectId: "p", delivery: { ...first, executionId: "interrupted", status: "sending" } });
    const recovered = new Orchestrator(journal);
    assert.equal(journal.readDelivery(first.taskId, first.messageId)?.status, "uncertain");
    assert.equal(recovered.snapshot("p", false).inboxes[0]!.uncertain, 1);
    assert.equal([...journal.scanDeliveries(first.taskId)].length, 71);
    assert.equal([...journal.scanDeliveries(undefined, first.messageId)].length, 1);
    const scan = journal.scanDeliveries()[Symbol.iterator]();
    scan.next();
    assert.throws(() => journal.compact(join(root, "blocked.sqlite")), /taraması bitmeden/);
    scan.return?.();
    recovered.checkpoint();
    journal.compact(join(root, "recovered.sqlite"));
    assert.deepEqual(new Orchestrator(journal).snapshot("p").deliveries, recovered.snapshot("p").deliveries);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

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
