import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HeadlessCliAdapter } from "../src/adapters/headless-cli.js";
import { MockAgent } from "../src/adapters/mock.js";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import type { AgentExecution } from "../src/core/contracts.js";
import { describeEvent, formatCost, formatDuration, formatTokens } from "../src/desktop/event-text.js";

const execution = (): AgentExecution => ({ workspaceRoot: process.cwd(), context: {}, inbox: [],
  task: { id: "t", projectId: "p", agentId: "a", title: "T", instruction: "x", dependsOn: [], allowedPaths: ["**"] } });

test("Claude results carry their billed cost and token totals, cached input included", async () => {
  const adapter = new HeadlessCliAdapter("a", "claude", { runner: async () => ({ stderr: "", events: [
    { type: "system", subtype: "init", session_id: "s" },
    { type: "result", session_id: "s", subtype: "success", is_error: false, result: "Ready", total_cost_usd: 0.0418,
      usage: { input_tokens: 8, cache_creation_input_tokens: 3342, cache_read_input_tokens: 23836, output_tokens: 513 } },
  ] }) });
  assert.deepEqual((await adapter.execute(execution())).usage, { costUsd: 0.0418, inputTokens: 27186, outputTokens: 513 });
  const silent = new HeadlessCliAdapter("a", "claude", { runner: async () => ({ stderr: "", events: [
    { type: "system", subtype: "init", session_id: "s" }, { type: "result", session_id: "s", subtype: "success", is_error: false, result: "Ready" },
  ] }) });
  assert.equal((await silent.execute(execution())).usage, undefined);
});

test("every run of a task is added up, failed runs count their time, and bad numbers are dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-usage-"));
  try {
    const engine = new Orchestrator(new Journal(join(root, "events.jsonl")));
    engine.createProject({ id: "p", workspaceRoot: root });
    let run = 0;
    engine.registerAgent(new MockAgent("a", async () => {
      run += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (run === 1) throw new Error("kota");
      return { summary: "ok", usage: { costUsd: 0.05, inputTokens: 1000, outputTokens: -5 } };
    }));
    engine.addTask({ id: "t", projectId: "p", agentId: "a", title: "T", instruction: "x", dependsOn: [], allowedPaths: [] });
    await engine.run("p");
    const failed = engine.snapshot("p").tasks[0]!.usage!;
    assert.equal(failed.runs, 1);
    assert.ok(failed.durationMs >= 15);
    assert.equal(failed.costUsd, undefined);
    engine.retryTask("t");
    await engine.run("p");
    const total = engine.snapshot("p").tasks[0]!.usage!;
    assert.deepEqual([total.runs, total.costUsd, total.inputTokens, total.outputTokens], [2, 0.05, 1000, undefined]);
    assert.ok(total.durationMs >= failed.durationMs + 15);
    const replayed = new Orchestrator(new Journal(join(root, "events.jsonl")));
    assert.deepEqual(replayed.snapshot("p").tasks[0]!.usage, total);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("usage reads naturally in Turkish", () => {
  assert.equal(formatDuration(34_400), "34 sn");
  assert.equal(formatDuration(125_000), "2 dk 5 sn");
  assert.equal(formatCost(0.0418), "$0,04");
  assert.equal(formatCost(0.004), "<$0,01");
  assert.equal(formatTokens(27_699), "28 B");
  assert.equal(formatTokens(1_250_000), "1,3 M");
  assert.equal(describeEvent({ type: "task.usage.recorded", projectId: "p", taskId: "t", durationMs: 16_000, usage: { costUsd: 0.05, inputTokens: 900, outputTokens: 100 } }),
    "Ajan çalışması bitti: 16 sn · $0,05 · 1 B token");
});
