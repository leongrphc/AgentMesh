import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTaskResult } from "../src/adapters/task-result.js";

const envelope = () => ({ agentmeshVersion: 1, summary: "Implemented", facts: [{ key: "api.contract", value: "POST /login" }], messages: [{ to: "reviewer", kind: "handoff", body: "Please review" }] });
test("versioned agent output extracts shared facts and messages, retaining the native session", () => {
  const output = normalizeTaskResult({ summary: "```json\n" + JSON.stringify(envelope()) + "\n```", sessionId: "native" }, ["reviewer"]);
  assert.equal(output.summary, "Implemented"); assert.equal(output.sessionId, "native");
  assert.equal(output.facts?.[0]?.key, "api.contract"); assert.equal(output.messages?.[0]?.to, "reviewer");
  assert.equal(normalizeTaskResult({ summary: "Plain summary" }).summary, "Plain summary");
  assert.equal(normalizeTaskResult({ summary: '{"some":"task data"}' }).summary, '{"some":"task data"}');
});
test("structured output rejects foreign recipients, reserved keys, duplicates, bad schemas and limits", () => {
  for (const patch of [{ agentmeshVersion: 2 }, { summary: "" }, { facts: [{ key: "task.other.summary", value: "spoof" }] },
    { facts: [envelope().facts[0], envelope().facts[0]] }, { messages: [{ to: "foreign", kind: "handoff", body: "leak" }] },
    { messages: [{ to: "reviewer", kind: "unknown", body: "x" }] }, { facts: new Array(33).fill({ key: "x", value: "x" }) }]) {
    assert.throws(() => normalizeTaskResult({ summary: JSON.stringify({ ...envelope(), ...patch }) }, ["reviewer"]));
  }
});

test("structured test evidence validates statuses and bounds and redacts diagnostics", () => {
  const tests = [{ name: "Unit tests", status: "passed", command: "npm test", details: "Result for user@example.com" },
    { name: "Integration", status: "not_run", details: "Missing database" }, { name: "Lint", status: "failed" }];
  const output = normalizeTaskResult({ summary: JSON.stringify({ ...envelope(), tests }) }, ["reviewer"]);
  assert.equal(output.tests?.[0]?.status, "passed");
  assert.equal(output.tests?.[1]?.status, "not_run");
  assert.ok(!output.tests?.[0]?.details?.includes("user@example.com"));
  for (const invalid of [null, {}, new Array(33).fill(tests[0]), [{ name: "x", status: "unknown" }],
    [{ name: "x", status: ["passed"] }], [{ name: "", status: "passed" }],
    [{ name: "x", status: "passed", command: "x".repeat(2001) }],
    [{ name: "x", status: "passed", details: "x".repeat(8193) }]]) {
    assert.throws(() => normalizeTaskResult({ summary: JSON.stringify({ ...envelope(), tests: invalid }) }), /Test|test/);
  }
});
