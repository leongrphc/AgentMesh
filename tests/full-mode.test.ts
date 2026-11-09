import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../src/core/journal.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { configJournalPath } from "../src/core/journal-location.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import { PermissionBroker } from "../src/core/permissions.js";
import { DesktopService } from "../src/desktop/service.js";
import type { DomainEvent } from "../src/core/contracts.js";

const proposal = { provider: "test", sessionId: "session", nativeRequestId: "request", kind: "command" as const, description: "npm test" };

test("Full Mode permissions retain journal, cancellation and duplicate safeguards", async () => {
  const events: DomainEvent[] = [];
  const broker = new PermissionBroker((event) => { events.push(event); });
  const scope = { projectId: "p", taskId: "t", executionId: "e" };
  const signal = new AbortController().signal;
  assert.equal(await broker.request(scope, proposal, signal, true), "allow_once");
  assert.equal(events.at(-1)?.type, "permission.resolved");
  assert.ok(events.some((event) => event.type === "permission.resolved" && event.source === "full_mode"));
  assert.equal(await broker.request(scope, proposal, signal, true), "deny");
  assert.equal(await broker.request({ ...scope, executionId: "cancelled" }, proposal, AbortSignal.abort(), true), "deny");
  const failing = new PermissionBroker((event) => { if (event.type === "permission.resolved") throw new Error("disk error"); });
  assert.equal(await failing.request(scope, proposal, signal, true), "deny");
});

test("Full Mode is opt-in, persists per project and validates its value", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-mode-settings-"));
  const service = new DesktopService(root);
  try {
    assert.equal(service.openDemo().snapshot.project.settings?.fullMode, undefined);
    service.updateSettings({ fullMode: true, autoContinue: true });
    await service.close();
    assert.equal(service.openDemo().snapshot.project.settings?.fullMode, true);
    assert.throws(() => service.updateSettings({ fullMode: "yes" } as never), /Full Mode/);
    service.updateSettings({ fullMode: false });
    assert.equal(service.state().snapshot.project.settings?.fullMode, undefined);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop Full Mode merges waiting review and applies it without provider calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-mode-desktop-"));
  const repo = join(root, "repo");
  const service = new DesktopService(join(root, "desktop"));
  let journal: SqliteJournal | undefined;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "-b", "main", repo]);
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "initial.txt"), "initial\n"); git("add", "."); git("commit", "-m", "initial");
    journal = new SqliteJournal(configJournalPath(repo));
    const engine = new Orchestrator(journal, new WorktreeManager());
    engine.createProject({ id: "p", workspaceRoot: repo });
    engine.registerAgent({ id: "a", provider: "test", connection: "cli", async execute({ workspaceRoot }) {
      writeFileSync(join(workspaceRoot, "feature.txt"), "automatic\n"); return { summary: "done" };
    } });
    const task = { id: "first", projectId: "p", agentId: "a", title: "first", instruction: "first", dependsOn: [], allowedPaths: ["feature.txt"] };
    engine.addTask(task); await engine.run("p");
    assert.equal(engine.snapshot("p").tasks[0]?.status, "pending_review");
    journal.close();
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: repo, agents: [{ id: "a", provider: "codex" }], tasks: [task] }));
    service.openConfig(config); service.updateSettings({ fullMode: true });
    const finished = new Promise<void>((resolve) => {
      let started = false;
      const off = service.subscribe((state) => {
        if (state.busy) started = true;
        if (started && !state.busy) { off(); resolve(); }
      });
    });
    service.start(); await finished;
    assert.equal(service.state().snapshot.tasks[0]?.status, "completed");
    assert.equal(service.state().integrationPending, 0);
    assert.equal(readFileSync(join(repo, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "automatic\n");
    assert.equal(git("status", "--porcelain"), "");
  } finally { journal?.close(); await service.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

for (const mode of ["normal", "full", "failing-test", "outside-scope"] as const) {
  test(`${mode}: automatic review respects mode, tests and file scope`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-mode-run-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
      writeFileSync(join(root, "initial.txt"), "initial\n"); git("add", "."); git("commit", "-m", "initial");
      const journal = new Journal(join(root, ".git", "mode.jsonl"));
      const manager = new WorktreeManager();
      const engine = new Orchestrator(journal, manager);
      engine.createProject({ id: "p", workspaceRoot: root });
      engine.updateSettings("p", { fullMode: mode !== "normal",
        ...(mode === "failing-test" ? { testCommand: `node -e "process.exit(1)"` } : {}) });
      let calls = 0;
      engine.registerAgent({ id: "a", provider: "test", connection: "cli", async execute(input) {
        calls++;
        if (input.task.id === "first") writeFileSync(join(input.workspaceRoot, mode === "outside-scope" ? "forbidden.txt" : "feature.txt"), "feature\n");
        else assert.equal(readFileSync(join(input.workspaceRoot, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "feature\n");
        if (mode === "full") assert.equal(await input.requestPermission!(proposal), "allow_once");
        return { summary: "done" };
      } });
      for (const id of ["first", "next"]) engine.addTask({ id, projectId: "p", agentId: "a", title: id, instruction: id,
        dependsOn: id === "next" ? ["first"] : [], allowedPaths: ["feature.txt"] });
      const result = await engine.run("p");
      if (mode === "full") {
        assert.ok(result.tasks.every((task) => task.status === "completed"));
        assert.equal(calls, 2);
        manager.applyIntegration(root);
        assert.equal(readFileSync(join(root, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "feature\n");
      } else {
        assert.equal(result.tasks[0]?.status, mode === "outside-scope" ? "failed" : "pending_review");
        assert.equal(calls, 1);
        assert.equal(manager.pendingIntegration(root), 0);
      }
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}
