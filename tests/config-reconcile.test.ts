import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileTasks, validate, type Config } from "../src/core/config.js";
import { DesktopService } from "../src/desktop/service.js";

const definition = { id: "first", projectId: "p", title: "First", instruction: "Implement first", agentId: "a", dependsOn: [], allowedPaths: ["src/**", "tests/**"] };
const config = (): Config => ({ projectId: "p", repoPath: ".", agents: [{ id: "a", provider: "codex" }, { id: "b", provider: "opencode" }], tasks: [structuredClone(definition)] });

test("config preflight reports changed task fields, ignores set order and orders additions", () => {
  const initial = config();
  for (const patch of [{ instruction: "Different" }, { title: "New title" }, { agentId: "b" }, { allowedPaths: ["**"] }, { dependsOn: ["new"] }]) {
    assert.throws(() => reconcileTasks({ ...initial, tasks: [{ ...definition, ...patch }] }, [definition]), /Config uyumsuzluğu: first/);
  }
  assert.deepEqual(reconcileTasks({ ...initial, tasks: [{ ...definition, allowedPaths: [...definition.allowedPaths].reverse() }] }, [definition]), []);
  const next = { ...definition, id: "next", dependsOn: ["first"] };
  const last = { ...definition, id: "last", dependsOn: ["next"] };
  assert.deepEqual(reconcileTasks({ ...initial, tasks: [last, next, definition] }, [definition]).map((task) => task.id), ["next", "last"]);
  assert.throws(() => reconcileTasks({ ...initial, tasks: [next] }, [definition], ["next"]), /başka projesinde/);
  assert.throws(() => validate({ ...initial, tasks: [definition, { ...next, dependsOn: ["first", "first"] }] }), /Geçersiz görev/);
});

test("desktop rejects drift before adding tasks, preserves UI tasks and previous journal after rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-config-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const file = join(root, "config.json");
  const initial = { ...config(), repoPath: repo };
  const service = new DesktopService(join(root, "demo"));
  const save = (value: Config) => writeFileSync(file, JSON.stringify(value));
  try {
    save(initial); service.openConfig(file);
    service.createTask({ ...definition, id: "ui-task", agentId: "b", dependsOn: ["first"] });
    const before = service.state().events.length;
    save({ ...initial, tasks: [{ ...definition, id: "new" }, { ...definition, instruction: "Changed sensitive content" }] });
    assert.throws(() => service.openConfig(file), /first.*instruction/);
    assert.equal(service.state().events.length, before);
    assert.equal(service.state().snapshot.tasks.length, 2);
    assert.equal(service.state().snapshot.tasks[0]!.instruction, definition.instruction);
    save({ ...initial, agents: [initial.agents[0]!] });
    assert.throws(() => service.openConfig(file), /Config ajan ayarları kayıtlı sürümden farklı/);
    service.setParallelism(3);
    await service.close();
    save(initial); service.openConfig(file);
    assert.equal(service.state().snapshot.tasks.length, 2);
    assert.equal(service.state().maxParallel, 3);
    assert.equal(service.state().snapshot.tasks.find((task) => task.id === "ui-task")?.agentId, "b");
    save({ ...initial, tasks: [definition, { ...definition, id: "new", dependsOn: ["first"] }] });
    assert.equal(service.openConfig(file).snapshot.tasks.length, 3);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
