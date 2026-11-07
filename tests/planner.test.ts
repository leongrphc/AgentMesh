import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanPrompt, MAX_PLAN_TASKS, parsePlan } from "../src/desktop/planner.js";
import type { AgentConfig } from "../src/core/config.js";
import type { AgentTask } from "../src/core/contracts.js";

const agents: AgentConfig[] = [{ id: "claude", provider: "claude" }, { id: "codex", provider: "codex" }];
const existing: AgentTask[] = [{ id: "setup", projectId: "p", agentId: "claude", title: "Kurulum", instruction: "x", dependsOn: [], allowedPaths: ["**"] }];

test("a fenced plan is parsed, ordered dependencies-first and cleaned up", () => {
  const reply = "İşte plan:\n```json\n" + JSON.stringify({ tasks: [
    { id: "UI Ekranı", title: "Arayüz", instruction: "Formu yap", agentId: "codex", dependsOn: ["api"], allowedPaths: ["src/ui/**"] },
    { id: "api", title: "API", instruction: "Endpoint", agentId: "ghost", dependsOn: ["setup", "nope", "api"] },
    { id: "setup", title: "Çakışan kimlik", instruction: "y", agentId: "claude" },
    { title: "", instruction: "başlıksız olduğu için atlanır" },
  ] }) + "\n```\nBaşka bir şey.";
  const drafts = parsePlan(reply, agents, existing);
  assert.deepEqual(drafts.map((draft) => draft.id), ["setup-2", "api", "ui-ekrani"]);
  const byId = Object.fromEntries(drafts.map((draft) => [draft.id, draft]));
  assert.equal(byId.api!.agentId, "claude", "unknown agents fall back to the first agent");
  // The plan defined its own "setup" (renamed to avoid the existing task), so its references follow the rename.
  assert.deepEqual(byId.api!.dependsOn, ["setup-2"], "unknown and self dependencies are dropped");
  assert.deepEqual(byId.api!.allowedPaths, ["**"]);
  assert.deepEqual(byId["ui-ekrani"]!.dependsOn, ["api"]);
  assert.deepEqual(byId["ui-ekrani"]!.allowedPaths, ["src/ui/**"]);
});

test("plans may depend on tasks that already exist in the project", () => {
  const drafts = parsePlan(JSON.stringify({ tasks: [{ id: "api", title: "API", instruction: "x", dependsOn: ["setup"] }] }), agents, existing);
  assert.deepEqual(drafts[0]!.dependsOn, ["setup"]);
});

test("plans with cycles, no tasks or no JSON are rejected with a readable reason", () => {
  assert.throws(() => parsePlan("Bunu yapamam.", agents, []), /JSON bir plan döndürmedi/);
  assert.throws(() => parsePlan("{bozuk", agents, []), /JSON/);
  assert.throws(() => parsePlan(JSON.stringify({ tasks: [] }), agents, []), /görev yok/);
  assert.throws(() => parsePlan(JSON.stringify({ tasks: [
    { id: "a", title: "A", instruction: "a", dependsOn: ["b"] }, { id: "b", title: "B", instruction: "b", dependsOn: ["a"] },
  ] }), agents, []), /Döngüsel/);
  const many = { tasks: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, instruction: "x" })) };
  assert.equal(parsePlan(JSON.stringify(many), agents, []).length, MAX_PLAN_TASKS);
});

test("the planner prompt carries the goal, agents, existing tasks and the project overview", () => {
  const prompt = buildPlanPrompt("Yorum sistemi ekle", [{ ...agents[0]!, role: "Arka uç" }, agents[1]!], "Dosyalar (2):\na.ts\nb.ts", existing);
  for (const part of ["Yorum sistemi ekle", "- claude (claude; rol: Arka uç)", "- codex (codex)", "- setup: Kurulum", "a.ts", '"tasks"']) assert.ok(prompt.includes(part), part);
});
