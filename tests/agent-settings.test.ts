import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";
import { resolveAgentSettings, validateAgentEdit } from "../src/core/agent-settings.js";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { MockAgent } from "../src/adapters/mock.js";
import { buildPrompt } from "../src/adapters/cli-process.js";
import type { Config } from "../src/core/config.js";
import type { TaskRecord } from "../src/core/contracts.js";

test("desktop agent edits survive reopen, share persisted settings and reject external drift without changing the source file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-agents-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const file = join(root, "config.json");
  const config: Config = { projectId: "p", repoPath: repo, agents: [{ id: "worker", provider: "codex" }], tasks: [] };
  const original = JSON.stringify(config);
  writeFileSync(file, original);
  const service = new DesktopService(join(root, "demo"));
  try {
    service.openConfig(file);
    service.saveAgent({ id: "worker", provider: "opencode", transport: "server", model: "provider/model", role: "Review tests" });
    service.saveAgent({ id: "planner", provider: "antigravity", role: "Plan work" });
    service.createTask({ id: "plan", agentId: "planner", title: "Plan", instruction: "Plan", dependsOn: [], allowedPaths: ["src/**"] });
    assert.equal(readFileSync(file, "utf8"), original);
    await service.close();
    const restored = service.openConfig(file);
    assert.equal(restored.agents.length, 2);
    assert.equal(restored.agents.find((agent) => agent.id === "worker")?.model, "provider/model");
    assert.equal(restored.agents.find((agent) => agent.id === "worker")?.role, "Review tests");
    assert.equal(restored.snapshot.tasks[0]?.agentId, "planner");
    const before = service.state();
    writeFileSync(file, JSON.stringify({ ...config, agents: [{ id: "worker", provider: "claude" }] }));
    assert.throws(() => service.openConfig(file), /kayıtlı sürümden farklı/);
    assert.deepEqual(service.state().agents, before.agents);
    assert.throws(() => service.saveAgent({ id: "bad", provider: "claude", transport: "server" }), /Geçersiz/);
    assert.throws(() => service.saveAgent({ id: "bad", provider: "codex", role: "x".repeat(2001) }), /Geçersiz/);
    assert.equal(service.state().agents.length, 2);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("used agents cannot change execution identity or role, including pending retries with retained sessions", () => {
  const agent = { id: "a", provider: "codex" as const };
  const task: TaskRecord = { id: "t", projectId: "p", agentId: "a", title: "Test", instruction: "Test", dependsOn: [], allowedPaths: ["src/**"], status: "pending" };
  for (const history of [{ status: "completed" as const }, { sessionId: "native" }, { worktree: { path: "repo", branch: "task" } }]) {
    for (const patch of [{ provider: "claude" as const }, { model: "other" }, { transport: "app-server" as const }, { role: "Different role" }]) {
      assert.throws(() => validateAgentEdit([agent], { ...agent, ...patch }, [{ ...task, ...history }]), /çalışma geçmişi/);
    }
  }
  validateAgentEdit([agent], { ...agent, transport: "exec" }, [{ ...task, sessionId: "native" }]);
  validateAgentEdit([agent], { ...agent, model: "new" }, [task]);
});

test("persisted agent roles reach task prompts after replay and settings resolve consistently for CLI consumers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-roles-"));
  try {
    const journal = new Journal(join(root, "events.jsonl"));
    const config: Config = { projectId: "p", repoPath: root, agents: [{ id: "a", provider: "codex" }], tasks: [] };
    const engine = new Orchestrator(journal);
    engine.createProject({ id: "p", workspaceRoot: root });
    engine.configureAgents("p", [{ ...config.agents[0]!, role: "Check edge cases" }], config.agents);
    const resolved = resolveAgentSettings(config, journal.all());
    assert.equal(resolved.agents[0]?.role, "Check edge cases");
    const replay = new Orchestrator(journal);
    replay.registerAgent(new MockAgent("a", async (input) => {
      assert.equal(input.agentRole, "Check edge cases");
      assert.match(buildPrompt(input), /Ajan rolü: Check edge cases/);
      return { summary: "Reviewed" };
    }));
    replay.addTask({ id: "t", projectId: "p", agentId: "a", title: "Test", instruction: "Test", dependsOn: [], allowedPaths: ["src/**"] });
    assert.equal((await replay.run("p")).tasks[0]?.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
