import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import type { AgentAdapter } from "../src/core/contracts.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "mesh-review-"));
  const repo = join(parent, "repo");
  git(parent, "init", "-q", repo);
  writeFileSync(join(repo, "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const root = realpathSync(repo);
  const journal = join(parent, "events.jsonl");
  const engine = new Orchestrator(new Journal(journal), new WorktreeManager());
  engine.createProject({ id: "p", workspaceRoot: root });
  const cli = (id: string, execute: AgentAdapter["execute"]): AgentAdapter => ({ id, provider: id, connection: "cli", execute });
  const addTask = () => engine.addTask({ id: "t", projectId: "p", agentId: "agent", title: "t", instruction: "multiply ekle", dependsOn: [], allowedPaths: ["**"] });
  return { root, journal, engine, cli, addTask, cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test("requesting changes sends the task back to the same agent, session and worktree with the feedback", async () => {
  const f = fixture();
  try {
    const calls: Array<{ session?: string; instruction: string; workspace: string }> = [];
    f.engine.registerAgent(f.cli("agent", async ({ task, sessionId, workspaceRoot, onSession }) => {
      calls.push({ session: sessionId, instruction: task.instruction, workspace: workspaceRoot });
      onSession?.("thread-1");
      writeFileSync(join(workspaceRoot, "math.ts"), calls.length === 1 ? "export const multiply = (a, b) => a * b;\n" : "export const multiply = (a: number, b: number) => a * b;\n");
      return { summary: `tur ${calls.length}`, sessionId: "thread-1" };
    }));
    f.addTask();
    await f.engine.run("p");
    assert.equal(f.engine.snapshot("p").tasks[0]!.status, "pending_review");
    assert.throws(() => f.engine.requestChanges("t", "   "), /neyi değiştirmesi/);

    f.engine.requestChanges("t", "Tipleri ekle.");
    const back = f.engine.snapshot("p").tasks[0]!;
    assert.deepEqual([back.status, back.sessionId, back.feedback?.round, back.feedback?.addressed], ["pending", "thread-1", 1, false]);
    assert.ok(back.worktree, "worktree is kept");

    await f.engine.run("p");
    const revised = f.engine.snapshot("p").tasks[0]!;
    assert.equal(revised.status, "pending_review");
    assert.equal(calls[1]!.session, "thread-1", "the agent resumes its own session");
    assert.equal(calls[1]!.workspace, calls[0]!.workspace, "and works in the same worktree");
    assert.match(calls[1]!.instruction, /İnceleme geri bildirimi \(1\. tur\)[\s\S]*Tipleri ekle\.[\s\S]*Asıl görev:\nmultiply ekle$/);
    assert.equal(revised.feedback?.addressed, true);
    assert.throws(() => f.engine.requestChanges("t", "x".repeat(8001)), /8000/);

    const replayed = new Orchestrator(new Journal(f.journal), new WorktreeManager());
    assert.deepEqual(replayed.snapshot("p").tasks[0]!.feedback, revised.feedback);
  } finally { f.cleanup(); }
});

test("the project test command runs in the worktree, its artefacts are discarded and agents cannot fake the verified mark", async () => {
  const f = fixture();
  try {
    f.engine.updateSettings("p", { testCommand: `node -e "require('fs').writeFileSync('coverage.txt','x'); process.exit(require('fs').readFileSync('math.ts','utf8').includes('multiply') ? 0 : 3)"` });
    assert.throws(() => f.engine.updateSettings("p", { testCommand: "a\nb" }), /tek satır/);
    f.engine.registerAgent(f.cli("agent", async ({ workspaceRoot }) => {
      writeFileSync(join(workspaceRoot, "math.ts"), "export const multiply = (a: number, b: number) => a * b;\n");
      return { summary: "bitti", tests: [{ name: "Benim testim", status: "passed", source: "agentmesh" } as never] };
    }));
    f.addTask();
    await f.engine.run("p");
    const task = f.engine.snapshot("p").tasks[0]!;
    assert.equal(task.status, "pending_review");
    assert.deepEqual(task.tests?.map((report) => [report.name, report.status, report.source]), [
      ["Proje testleri (AgentMesh çalıştırdı)", "passed", "agentmesh"],
      ["Benim testim", "passed", undefined],
    ]);
    assert.ok(!existsSync(join(task.worktree!.path, "coverage.txt")), "test output is removed from the worktree");
    const inspection = new WorktreeManager().inspectTask(f.root, task.worktree!, ["**"]);
    assert.deepEqual(inspection.changedPaths, ["math.ts"]);
    assert.equal(task.review?.digest, inspection.digest, "the review digest matches the cleaned worktree");
    assert.equal(task.testDigest, inspection.digest);

    // Approval keeps the verified mark on the completed task.
    f.engine.approveTask("t", task.review!.digest);
    assert.equal(f.engine.snapshot("p").tasks[0]!.tests?.[0]?.source, "agentmesh");
  } finally { f.cleanup(); }
});

test("a failing project test is reported as failed without blocking the review", async () => {
  const f = fixture();
  try {
    f.engine.updateSettings("p", { testCommand: `node -e "console.log('1 failing'); process.exit(1)"`, autoContinue: true });
    assert.deepEqual(f.engine.snapshot("p").project.settings, { testCommand: `node -e "console.log('1 failing'); process.exit(1)"`, autoContinue: true });
    f.engine.registerAgent(f.cli("agent", async ({ workspaceRoot }) => {
      writeFileSync(join(workspaceRoot, "math.ts"), "broken\n");
      return { summary: "bitti" };
    }));
    f.addTask();
    await f.engine.run("p");
    const task = f.engine.snapshot("p").tasks[0]!;
    assert.equal(task.status, "pending_review");
    assert.equal(task.tests?.[0]?.status, "failed");
    assert.match(task.tests?.[0]?.details ?? "", /Çıkış kodu 1[\s\S]*1 failing/);
    assert.equal(readFileSync(join(task.worktree!.path, "math.ts"), "utf8").replace(/\r\n/g, "\n"), "broken\n");
  } finally { f.cleanup(); }
});

test("after applying, finished task worktrees are removed while pending work is kept", async () => {
  const f = fixture();
  try {
    f.engine.registerAgent(f.cli("agent", async ({ task, workspaceRoot }) => {
      if (task.id !== "noop") writeFileSync(join(workspaceRoot, `${task.id}.txt`), task.id);
      return { summary: "ok" };
    }));
    for (const id of ["applied", "noop", "waiting"]) {
      f.engine.addTask({ id, projectId: "p", agentId: "agent", title: id, instruction: id, dependsOn: [], allowedPaths: ["**"] });
    }
    await f.engine.run("p");
    const byId = () => Object.fromEntries(f.engine.snapshot("p").tasks.map((task) => [task.id, task]));
    assert.equal(byId().noop!.status, "completed");
    const applied = byId().applied!;
    const paths = { applied: applied.worktree!.path, noop: byId().noop!.worktree!.path, waiting: byId().waiting!.worktree!.path };

    f.engine.approveTask("applied", applied.review!.digest);
    assert.deepEqual(f.engine.releaseFinishedWorktrees("p"), ["noop"], "approved but not yet applied work keeps its worktree");

    new WorktreeManager().applyIntegration(f.root);
    assert.deepEqual(f.engine.releaseFinishedWorktrees("p"), ["applied"]);
    assert.ok(!existsSync(paths.applied) && !existsSync(paths.noop));
    assert.ok(existsSync(paths.waiting), "a task still waiting for review is untouched");
    assert.equal(byId().applied!.worktree, undefined);
    assert.equal(byId().waiting!.status, "pending_review");
    assert.equal(git(f.root, "branch", "--list", "agentmesh/*-*").split("\n").filter((line) => line.trim() && !line.includes("integration")).length, 1);
    assert.equal(readFileSync(join(f.root, "applied.txt"), "utf8"), "applied", "the applied work is in the user's folder");

    const replayed = new Orchestrator(new Journal(f.journal), new WorktreeManager());
    assert.equal(replayed.snapshot("p").tasks.find((task) => task.id === "applied")!.worktree, undefined);
  } finally { f.cleanup(); }
});
