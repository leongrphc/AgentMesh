import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker, type PermissionProposal } from "../src/core/permissions.js";
import type { DomainEvent } from "../src/core/contracts.js";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";

const scope = { projectId: "p", taskId: "t", executionId: "exec-1" };
const proposal: PermissionProposal = { provider: "codex", sessionId: "thread", nativeRequestId: "turn:request-1", kind: "command", description: "npm test token=secret-value" };

test("permission decisions bind project/execution/digest; duplicate and stale grants are rejected", async () => {
  const events: DomainEvent[] = [];
  const broker = new PermissionBroker((event) => events.push(event));
  const abort = new AbortController();
  const pending = broker.request(scope, proposal, abort.signal);
  const item = broker.list("p")[0]!;
  assert.ok(!item.description.includes("secret-value"));
  assert.ok(!JSON.stringify(events).includes("secret-value"));
  assert.equal(await broker.request(scope, proposal, abort.signal), "deny");
  assert.throws(() => broker.decide("other-project", item.id, item.executionId, item.digest, "allow_once"));
  assert.throws(() => broker.decide("p", item.id, "other-run", item.digest, "allow_once"));
  assert.throws(() => broker.decide("p", item.id, item.executionId, "wrong-digest", "allow_once"));
  broker.decide("p", item.id, item.executionId, item.digest, "allow_once");
  assert.equal(await pending, "allow_once");
  assert.throws(() => broker.decide("p", item.id, item.executionId, item.digest, "allow_once"));
  assert.equal(broker.list("p").length, 0);
  broker.closeExecution(scope.executionId, "execution_ended");
});

test("timeout, cancellation and disconnect deny requests; journal failures never grant", async () => {
  for (const reason of ["timeout", "cancel", "disconnect"] as const) {
    const events: DomainEvent[] = [];
    const broker = new PermissionBroker((event) => events.push(event), 15);
    const abort = new AbortController();
    const pending = broker.request(scope, proposal, abort.signal);
    if (reason === "cancel") abort.abort();
    if (reason === "disconnect") broker.closeExecution(scope.executionId, "disconnect");
    assert.equal(await pending, "deny");
    const result = events.at(-1);
    assert.ok(result?.type === "permission.resolved" && result.source === reason);
  }
  let fail = false;
  const broker = new PermissionBroker(() => { if (fail) throw new Error("disk error"); });
  const pending = broker.request(scope, proposal, new AbortController().signal);
  const item = broker.list("p")[0]!;
  fail = true;
  assert.throws(() => broker.decide("p", item.id, item.executionId, item.digest, "allow_once"), /kaydedilemedi/);
  assert.equal(await pending, "deny");
});

test("restart denies historical pending permissions and preserves interrupted task review", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-permission-"));
  try {
    const file = join(root, "events.jsonl");
    const store = new Journal(file);
    store.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    store.append({ type: "task.created", task: { id: "t", projectId: "p", agentId: "a", title: "test", instruction: "test", dependsOn: [], allowedPaths: [] } });
    store.append({ type: "task.started", projectId: "p", taskId: "t" });
    store.append({ type: "permission.requested", projectId: "p", taskId: "t", executionId: "old-execution", requestId: "old-request",
      provider: "codex", kind: "command", digest: "old-digest", expiresAt: new Date().toISOString() });
    const engine = new Orchestrator(store);
    assert.equal(engine.pendingPermissions("p").length, 0);
    assert.equal(engine.snapshot("p").tasks[0]?.status, "needs_review");
    assert.throws(() => engine.decidePermission("p", "old-request", "old-execution", "old-digest", "allow_once"));
    assert.match(readFileSync(file, "utf8"), /"source":"restart"/);
    new Orchestrator(store);
    assert.equal(store.all().filter((event) => event.payload.type === "permission.resolved").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
