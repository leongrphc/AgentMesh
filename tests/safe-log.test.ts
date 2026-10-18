import assert from "node:assert/strict";
import { test } from "node:test";
import { safeLog } from "../src/core/safe-log.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { Journal } from "../src/core/journal.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("diagnostic secrets and email are masked before truncation", () => {
  const input = 'api_key="private-value" Bearer abc123 user@example.com sk-1234567890';
  const output = safeLog(input);
  for (const secret of ["private-value", "abc123", "user@example.com", "sk-1234567890"]) {
    assert.ok(!output.includes(secret));
  }
  assert.ok(safeLog("x".repeat(10000), "storage").length < safeLog("x".repeat(10000)).length);
  assert.ok(!safeLog("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----").includes("secret"));
});

test("adapter errors persist filtered diagnostics and live output is bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentmesh-log-"));
  try {
    const file = join(root, "events.jsonl");
    const engine = new Orchestrator(new Journal(file));
    const notices: string[] = [];
    engine.subscribe((notice) => notices.push(JSON.stringify(notice)));
    engine.createProject({ id: "p", workspaceRoot: root });
    engine.registerAgent({ id: "a", provider: "test", connection: "mock", async execute(input) {
      input.onOutput?.({ channel: "stdout", data: { token: "private-value", text: "x".repeat(20000) } });
      throw new Error('password="private-value" ' + "x".repeat(10000));
    } });
    engine.addTask({ id: "t", projectId: "p", agentId: "a", title: "test", instruction: "test", dependsOn: [], allowedPaths: [] });
    const snapshot = await engine.run("p");
    assert.equal(snapshot.tasks[0]?.status, "failed");
    assert.ok(!readFileSync(file, "utf8").includes("private-value"));
    assert.ok(!notices.join("").includes("private-value"));
    assert.ok((snapshot.tasks[0]?.error?.length ?? 0) < 2100);
    assert.ok(notices.some((notice) => notice.includes("TRUNCATED")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
