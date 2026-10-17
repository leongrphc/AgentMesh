import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { MockAgent } from "../src/adapters/mock.js";
import type { AgentTask } from "../src/core/contracts.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentmesh-test-"));
  const path = join(root, "events.jsonl");
  const engine = new Orchestrator(new Journal(path));
  engine.createProject({ id: "p", workspaceRoot: root });
  const makeTask = (id: string, agentId: string, dependsOn: string[] = []): AgentTask => ({
    id, agentId, projectId: "p", title: id, instruction: id, dependsOn, allowedPaths: [],
  });
  return { root, path, engine, makeTask, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("paralel bağımsız işler aynı context'i alır; reviewer mesaj ve sonuçları görür", async () => {
  const f = fixture();
  try {
    let active = 0;
    let maxActive = 0;
    f.engine.registerAgent(new MockAgent("planner", async () => ({
      summary: "plan hazır",
      facts: [{ key: "api.contract", value: "POST /login" }],
    })));
    f.engine.registerAgent(new MockAgent("worker", async ({ context, task }) => {
      assert.equal(context["api.contract"]?.value, "POST /login");
      active += 1;
      maxActive = Math.max(active, maxActive);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return {
        summary: `${task.id} tamamlandı`,
        facts: [{ key: `${task.id}.state`, value: "ready" }],
        messages: [{ to: "reviewer", kind: "handoff", body: `${task.id} hazır` }],
      };
    }));
    f.engine.registerAgent(new MockAgent("reviewer", async ({ context, inbox }) => {
      assert.equal(context["front.state"]?.value, "ready");
      assert.equal(context["back.state"]?.value, "ready");
      assert.equal(inbox.length, 2);
      return { summary: "kontrol edildi" };
    }));
    f.engine.addTask(f.makeTask("plan", "planner"));
    f.engine.addTask(f.makeTask("front", "worker", ["plan"]));
    f.engine.addTask(f.makeTask("back", "worker", ["plan"]));
    f.engine.addTask(f.makeTask("review", "reviewer", ["front", "back"]));
    const result = await f.engine.run("p", 2);
    assert.equal(maxActive, 2);
    assert.ok(result.tasks.every((task) => task.status === "completed"));
    assert.equal(result.messages.length, 2);

    // Kapat/aç: state yeniden kurulur, bitmiş işler tekrar çalışmaz.
    const restored = new Orchestrator(new Journal(f.path));
    const snapshot = restored.snapshot("p");
    assert.equal(snapshot.tasks.length, 4);
    assert.equal(snapshot.context["back.state"]?.value, "ready");
    assert.equal(snapshot.messages.length, 2);
  } finally { f.cleanup(); }
});

test("başarısızlık bağımlıyı engeller; açık tekrar denemede toparlar", async () => {
  const f = fixture();
  try {
    let failing = true;
    f.engine.registerAgent(new MockAgent("worker", async () => {
      if (failing) throw new Error("test hata");
      return { summary: "düzeltildi" };
    }));
    f.engine.addTask(f.makeTask("one", "worker"));
    f.engine.addTask(f.makeTask("two", "worker", ["one"]));
    let result = await f.engine.run("p");
    assert.deepEqual(result.tasks.map((task) => task.status), ["failed", "blocked"]);
    assert.equal(result.tasks[0]?.error, "test hata");
    failing = false;
    f.engine.retryTask("one");
    f.engine.retryTask("two");
    result = await f.engine.run("p");
    assert.ok(result.tasks.every((task) => task.status === "completed"));
  } finally { f.cleanup(); }
});

test("çöken çalıştırma otomatik tekrarlanmaz ve needs_review olur", () => {
  const f = fixture();
  try {
    f.engine.registerAgent(new MockAgent("worker", async () => ({ summary: "ok" })));
    f.engine.addTask(f.makeTask("in-progress", "worker"));
    new Journal(f.path).append({ type: "task.started", projectId: "p", taskId: "in-progress" });
    const restored = new Orchestrator(new Journal(f.path));
    assert.equal(restored.snapshot("p").tasks[0]?.status, "needs_review");
  } finally { f.cleanup(); }
});

test("çapraz proje bağımlılığı kabul edilmez", () => {
  const f = fixture();
  try {
    f.engine.registerAgent(new MockAgent("worker", async () => ({ summary: "ok" })));
    f.engine.addTask(f.makeTask("first", "worker"));
    f.engine.createProject({ id: "q", workspaceRoot: f.root });
    assert.throws(() => f.engine.addTask({ ...f.makeTask("other", "worker", ["first"]), projectId: "q" }), /Geçersiz bağımlılık/);
  } finally { f.cleanup(); }
});
