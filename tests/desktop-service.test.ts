import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";

test("desktop service cancels, retries and restores persisted demo without calling providers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-desktop-"));
  const service = new DesktopService(root);
  try {
    const initial = service.openDemo();
    await service.checkAgents();
    assert.ok(Object.values(service.state().health).every((health) => health.status === "configured"));
    assert.equal(initial.snapshot.tasks.length, 4);
    initial.snapshot.tasks[0]!.title = "mutated outside";
    assert.notEqual(service.state().snapshot.tasks[0]!.title, "mutated outside");
    const finished = new Promise<void>((resolve) => {
      let started = false;
      const off = service.subscribe((state) => {
        if (state.busy) started = true;
        if (started && !state.busy) { off(); resolve(); }
      });
    });
    service.start();
    assert.equal(service.state().busy, true);
    assert.throws(() => service.start(), /zaten/);
    assert.throws(() => service.openDemo(), /durdurun/);
    assert.throws(() => service.setParallelism(3), /durdurun/);
    service.cancel();
    await finished;
    assert.ok(service.state().snapshot.tasks.every((task) => task.status === "cancelled"));
    service.retry("plan");
    assert.equal(service.state().snapshot.tasks[0]?.status, "pending");
    assert.throws(() => service.retry("not-a-task"), /Geçersiz/);
    const draft = { id: "custom", title: "Custom task", instruction: "Use the shared context", agentId: "reviewer",
      dependsOn: ["plan"], allowedPaths: ["src/**"] };
    service.createTask(draft);
    assert.throws(() => service.createTask(draft), /Geçersiz/);
    assert.throws(() => service.createTask({ ...draft, id: "bad", dependsOn: ["missing"] }), /bağımlılığı/);
    assert.throws(() => service.setParallelism(0), /1-8/);
    assert.throws(() => service.setParallelism(9), /1-8/);
    service.setParallelism(3);
    await service.close();
    service.openDemo();
    assert.equal(service.state().snapshot.tasks[0]?.status, "pending");
    assert.equal(service.state().snapshot.tasks[1]?.status, "cancelled");
    assert.equal(service.state().snapshot.tasks.find((task) => task.id === "custom")?.title, "Custom task");
    assert.equal(service.state().maxParallel, 3);
    assert.ok(service.state().events.some((event) => event.text === "project.parallelism.updated"));
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed project opening preserves the previous workspace and its writable journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-open-"));
  const repo = join(root, "repo"), other = join(root, "other");
  mkdirSync(repo); mkdirSync(other);
  const key = createHash("sha256").update(process.platform === "win32" ? repo.toLowerCase() : repo).digest("hex").slice(0, 16);
  const store = new SqliteJournal(join(root, ".agentmesh-data", key, "events.sqlite"));
  store.append({ type: "project.created", project: { id: "p", workspaceRoot: other } }); store.close();
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: repo, agents: [], tasks: [] }));
  const service = new DesktopService(join(root, "demo"));
  try {
    service.openDemo();
    assert.throws(() => service.openConfig(config), /başka depoya/);
    assert.equal(service.state().demo, true);
    service.setParallelism(3);
    assert.equal(service.state().maxParallel, 3);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop message tests serialize, cancel before model access and do not persist prompt text", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-message-service-"));
  const service = new DesktopService(root);
  try {
    service.openDemo();
    const before = service.state().events.length;
    await assert.rejects(service.openProviderTerminal("invalid-model"), /provider\/model/);
    const pending = service.testProvider({ provider: "codex", message: "private greeting" });
    assert.equal(service.state().testingProvider, "codex");
    assert.throws(() => service.testProvider({ provider: "codex", message: "duplicate" }), /aktif işlemi/);
    assert.throws(() => service.openDemo(), /mesaj testini/);
    assert.throws(() => service.start(), /mesaj testini/);
    await assert.rejects(service.openProviderTerminal("opencode/space-bunny-free"), /aktif işlemi/);
    service.cancelProviderTest();
    await assert.rejects(pending, /iptal/);
    assert.equal(service.state().testingProvider, undefined);
    assert.equal(service.state().events.length, before);
    await service.close(); service.openDemo();
    assert.equal(service.state().testingProvider, undefined);
    assert.ok(!JSON.stringify(service.state()).includes("private greeting"));
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
