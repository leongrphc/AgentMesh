import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Orchestrator } from "../src/core/orchestrator.js";
import { Journal } from "../src/core/journal.js";
import { MockAgent } from "../src/adapters/mock.js";
import { ExecutionInbox } from "../src/core/inbox.js";
import type { AgentExecution, AgentMessage, AgentTask } from "../src/core/contracts.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mesh-inbox-"));
  const journal = new Journal(join(root, "events.jsonl"));
  const engine = new Orchestrator(journal);
  engine.createProject({ id: "p", workspaceRoot: root });
  const task = (id: string, agentId = id): AgentTask => ({ id, projectId: "p", agentId, title: id, instruction: id, dependsOn: [], allowedPaths: ["src/**"] });
  return { root, journal, engine, task, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("live messages fan out to concurrent tasks, deduplicate sends and persist task-scoped cursors", async () => {
  const f = fixture();
  const ready = deferred();
  let waiting = 0;
  let send: AgentExecution["sendMessage"];
  try {
    f.engine.registerAgent(new MockAgent("receiver", async (input) => {
      const delivered = deferred();
      const stop = input.subscribeInbox!(async (message) => {
        assert.equal(message.body, "Review this edge case");
        delivered.resolve(); return true;
      });
      if (++waiting === 2) ready.resolve();
      await delivered.promise; await stop();
      return { summary: "Received" };
    }));
    f.engine.registerAgent(new MockAgent("sender", async (input) => {
      send = input.sendMessage;
      await ready.promise;
      const draft = { to: "receiver", kind: "question" as const, body: "Review this edge case", idempotencyKey: "question-1" };
      const first = input.sendMessage!(draft);
      assert.equal(input.sendMessage!(draft), first);
      assert.throws(() => input.sendMessage!({ ...draft, body: "Changed" }), /farklı içerik/);
      assert.throws(() => input.sendMessage!({ ...draft, to: "foreign" }), /Geçersiz/);
      return { summary: "Sent" };
    }));
    f.engine.addTask(f.task("receiver-1", "receiver")); f.engine.addTask(f.task("receiver-2", "receiver")); f.engine.addTask(f.task("sender"));
    const snapshot = await f.engine.run("p", 3);
    assert.ok(snapshot.tasks.every((task) => task.status === "completed"));
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.deliveries.filter((delivery) => delivery.status === "accepted").length, 2);
    assert.equal(snapshot.inboxes.find((inbox) => inbox.taskId === "receiver-1")?.cursor, 1);
    assert.equal(snapshot.inboxes.find((inbox) => inbox.taskId === "receiver-2")?.cursor, 1);
    assert.throws(() => send!({ to: "*", kind: "progress", body: "Late", idempotencyKey: "late" }), /artık aktif/);
    const restored = new Orchestrator(new Journal(join(f.root, "events.jsonl"))).snapshot("p");
    assert.deepEqual(restored.deliveries, snapshot.deliveries);
    assert.deepEqual(restored.inboxes, snapshot.inboxes);
  } finally { f.close(); }
});

test("failed live delivery remains uncertain and is supplied on explicit retry; accepted inbox is not repeated", async () => {
  const f = fixture();
  const ready = deferred();
  const failed = deferred();
  let attempt = 0;
  try {
    f.engine.registerAgent(new MockAgent("worker", async (input) => {
      input.onSession?.("worker-native");
      if (++attempt === 1) {
        const stop = input.subscribeInbox!(async () => { failed.resolve(); throw new Error("Lost native acknowledgement"); });
        ready.resolve(); await failed.promise; await stop();
        throw new Error("Native turn interrupted");
      }
      assert.equal(input.inbox.length, attempt === 2 ? 1 : 0);
      throw new Error("Still incomplete");
    }));
    f.engine.addTask(f.task("worker"));
    const running = f.engine.run("p");
    await ready.promise;
    const id = f.engine.sendMessage("p", { to: "worker", kind: "progress", body: "Important", idempotencyKey: "user-1" });
    await running;
    assert.equal(f.engine.snapshot("p").deliveries.find((delivery) => delivery.messageId === id)?.status, "uncertain");
    f.engine.retryTask("worker"); await f.engine.run("p");
    assert.equal(f.engine.snapshot("p").deliveries[0]?.status, "accepted");
    f.engine.retryTask("worker"); await f.engine.run("p");
    assert.equal(f.engine.snapshot("p").inboxes[0]?.pending, 0);
  } finally { f.close(); }
});

test("restart marks interrupted sends uncertain and queues work without automatically executing a provider", () => {
  const f = fixture();
  try {
    f.engine.registerAgent(new MockAgent("a", () => ({ summary: "unused" })));
    f.engine.addTask(f.task("a"));
    const id = f.engine.sendMessage("p", { to: "a", kind: "question", body: "Question", idempotencyKey: "q" });
    f.journal.append({ type: "task.started", projectId: "p", taskId: "a" });
    f.journal.append({ type: "message.delivery", projectId: "p", delivery: { taskId: "a", messageId: id, executionId: "old", status: "sending", mode: "live" } });
    const replay = new Orchestrator(f.journal).snapshot("p");
    assert.equal(replay.tasks[0]?.status, "needs_review");
    assert.equal(replay.deliveries[0]?.status, "uncertain");
    assert.equal(replay.inboxes[0]?.uncertain, 1);
  } finally { f.close(); }
});

test("a retry without a retained native session receives previously accepted context again", async () => {
  const f = fixture();
  let attempts = 0;
  try {
    f.engine.registerAgent(new MockAgent("a", async (input) => {
      attempts++;
      assert.equal(input.sessionId, undefined);
      assert.equal(input.inbox.length, 1);
      throw new Error("Incomplete work without a resumable session");
    }));
    f.engine.addTask(f.task("a"));
    f.engine.sendMessage("p", { to: "a", kind: "progress", body: "Keep this context", idempotencyKey: "context" });
    await f.engine.run("p");
    assert.equal(f.engine.snapshot("p").deliveries[0]?.status, "accepted");
    f.engine.retryTask("a");
    await f.engine.run("p");
    assert.equal(attempts, 2);
    assert.equal(f.engine.snapshot("p").messages.length, 1);
  } finally { f.close(); }
});

test("cancellation drains a stuck receiver promptly and never accepts a late delivery", async () => {
  const abort = new AbortController();
  const started = deferred();
  const late = deferred<boolean>();
  const states: string[] = [];
  const message: AgentMessage = { id: "m", projectId: "p", taskId: "sender", from: "sender", to: "receiver", kind: "progress", body: "x", createdAt: "" };
  const inbox = new ExecutionInbox({ active: () => !abort.signal.aborted, signal: abort.signal,
    pending: () => [message], record: (_id, state) => states.push(state), onError: (error) => { throw error; } });
  const close = inbox.subscribe(async () => { started.resolve(); return late.promise; });
  await started.promise; abort.abort(); await close();
  late.resolve(true);
  await Promise.resolve();
  assert.deepEqual(states, ["sending", "uncertain"]);
});

test("non-live adapters receive queued messages on the next explicit execution and user idempotency survives replay", async () => {
  const f = fixture();
  const ready = deferred();
  const finish = deferred();
  let attempt = 0;
  try {
    f.engine.registerAgent({ id: "a", provider: "test", connection: "mock", async execute(input) {
      assert.equal(input.subscribeInbox, undefined);
      if (++attempt === 1) { ready.resolve(); await finish.promise; throw new Error("Retry needed"); }
      assert.equal(input.inbox.length, 1);
      return { summary: "Received queued message" };
    } });
    f.engine.addTask(f.task("a"));
    const run = f.engine.run("p"); await ready.promise;
    const draft = { to: "a", kind: "progress" as const, body: "Queued", idempotencyKey: "queued" };
    const id = f.engine.sendMessage("p", draft);
    finish.resolve(); await run;
    assert.equal(f.engine.snapshot("p").deliveries.length, 0);
    const replay = new Orchestrator(f.journal);
    assert.equal(replay.sendMessage("p", draft), id);
    f.engine.retryTask("a"); await f.engine.run("p");
    assert.equal(f.engine.snapshot("p").deliveries[0]?.mode, "prompt");
    assert.equal(f.engine.snapshot("p").deliveries[0]?.status, "accepted");
  } finally { f.close(); }
});
