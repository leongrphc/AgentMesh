import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareContext } from "../src/core/context-package.js";
import { validateContextKeys } from "../src/core/context.js";
import { reconcileTasks } from "../src/core/config.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { Journal } from "../src/core/journal.js";
import { MockAgent } from "../src/adapters/mock.js";
import type { AgentTask, Fact } from "../src/core/contracts.js";

const task = (id: string, dependsOn: string[] = []): AgentTask => ({ id, dependsOn, projectId: "p", agentId: "a", title: id, instruction: id, allowedPaths: ["src/**"] });
const fact = (key: string, value = "İstanbul", revision = 1): Fact => ({ key, value, revision, sourceTaskId: "a", updatedAt: "2026-01-01" });
const facts = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, fact(key)]));

test("context selection includes transitive dependency summaries, excludes unrelated summaries and has stable evidence", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["b"]), task("unrelated")];
  const input = facts("task.unrelated.summary", "decision", "task.b.summary", "task.a.summary");
  const first = prepareContext(tasks[2]!, tasks, input, "one");
  const reordered = prepareContext(tasks[2]!, tasks, Object.fromEntries(Object.entries(input).reverse()), "two");
  assert.deepEqual(Object.keys(first.context), ["decision", "task.a.summary", "task.b.summary"]);
  assert.equal(first.metadata.digest, reordered.metadata.digest);
  assert.equal(first.metadata.bytes, Buffer.byteLength(JSON.stringify(first.context)));
  first.context.decision!.value = "mutated";
  assert.equal(input.decision!.value, "İstanbul");
  assert.deepEqual(Object.keys(prepareContext({ ...tasks[2]!, contextKeys: [] }, tasks, input, "three").context), ["task.a.summary", "task.b.summary"]);
  assert.ok(prepareContext({ ...tasks[2]!, contextKeys: ["task.unrelated.summary"] }, tasks, input, "four").context["task.unrelated.summary"]);
  input.decision!.revision = 2;
  assert.notEqual(prepareContext(tasks[2]!, tasks, input, "five").metadata.digest, reordered.metadata.digest);
});

test("invalid, missing and oversized context fails without truncation", () => {
  for (const keys of [null, "decision", [""], ["x", "x"], [2], ["x".repeat(161)]]) assert.throws(() => validateContextKeys(keys), /Geçersiz/);
  const t = task("a");
  assert.throws(() => prepareContext({ ...t, contextKeys: ["missing"] }, [t], {}, "e"), /bulunamadı/);
  assert.throws(() => prepareContext(task("b", ["foreign"]), [task("foreign"), { ...task("foreign"), projectId: "other" }].slice(1), {}, "e"), /aynı projede/);
  assert.throws(() => prepareContext(t, [t], facts(...Array.from({ length: 129 }, (_, i) => `key${i}`)), "e"), /128 kayıt/);
  assert.throws(() => prepareContext(t, [t], { large: fact("large", "ş".repeat(131072)) }, "e"), /256 KiB/);
  assert.throws(() => prepareContext(t, [t], { broken: fact("broken", "x", 0) }, "e"), /sürüm/);
});

test("context selection is immutable config, with order ignored but empty and default distinguished", () => {
  const t = task("a");
  const config = { projectId: "p", repoPath: ".", agents: [{ id: "a", provider: "codex" as const }], tasks: [{ ...t, contextKeys: [] }] };
  assert.throws(() => reconcileTasks(config, [t]), /contextKeys/);
  assert.deepEqual(reconcileTasks({ ...config, tasks: [{ ...t, contextKeys: ["b", "a"] }] }, [{ ...t, contextKeys: ["a", "b"] }]), []);
});

test("prepared revisions survive replay and retries, while missing input never invokes adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-package-"));
  try {
    const journal = new Journal(join(root, "events.jsonl"));
    const engine = new Orchestrator(journal);
    engine.createProject({ id: "p", workspaceRoot: root });
    let calls = 0;
    engine.registerAgent(new MockAgent("a", () => { calls++; throw new Error("retry me"); }));
    const definition = { ...task("a"), contextKeys: [] as string[] };
    engine.addTask(definition);
    definition.contextKeys.push("external mutation");
    await engine.run("p");
    engine.retryTask("a");
    await engine.run("p");
    assert.equal(calls, 2);
    const snapshot = engine.snapshot("p");
    const packages = snapshot.tasks[0]!.contextPackages!;
    assert.equal(packages.length, 2);
    assert.notEqual(packages[0]!.executionId, packages[1]!.executionId);
    assert.equal(packages[0]!.digest, packages[1]!.digest);
    assert.deepEqual(new Orchestrator(journal).snapshot("p"), snapshot);
    engine.addTask({ ...task("missing"), contextKeys: ["absent"] });
    await engine.run("p");
    assert.equal(calls, 2);
    assert.match(engine.snapshot("p").tasks.find((t) => t.id === "missing")!.error!, /bulunamadı/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
