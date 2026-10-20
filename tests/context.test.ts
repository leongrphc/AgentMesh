import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Orchestrator } from "../src/core/orchestrator.js";
import { Journal } from "../src/core/journal.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import { MockAgent } from "../src/adapters/mock.js";
import type { AgentTask } from "../src/core/contracts.js";

const task = (id: string, dependsOn: string[] = []): AgentTask => ({
  id, dependsOn, agentId: id, projectId: "p", title: id, instruction: id, allowedPaths: ["src/**"],
});

test("SQLite context upgrade preserves old events and rejects unknown future schemas without leaking the lock", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-context-schema-"));
  const path = join(root, "events.sqlite");
  try {
    const first = new SqliteJournal(path);
    first.append({ type: "project.created", project: { id: "p", workspaceRoot: root } }); first.close();
    const old = new DatabaseSync(path); old.exec("PRAGMA user_version=1"); old.close();
    const upgraded = new SqliteJournal(path);
    assert.equal(upgraded.all().length, 1); upgraded.close();
    const check = new DatabaseSync(path);
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    check.exec("PRAGMA user_version=4"); check.close();
    assert.throws(() => new SqliteJournal(path), /desteklenmiyor: 4/);
    const repair = new DatabaseSync(path); repair.exec("PRAGMA user_version=2"); repair.close();
    const reopened = new SqliteJournal(path); assert.equal(reopened.all().length, 1); reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mesh-context-"));
  const journal = new Journal(join(root, "events.jsonl"));
  const engine = new Orchestrator(journal);
  engine.createProject({ id: "p", workspaceRoot: root });
  return { root, journal, engine, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("competing decisions pause new waves, require current revisions and preserve history through replay", async () => {
  const f = fixture();
  let reviewed = false;
  try {
    for (const [id, value] of [["plan", "original"], ["a", "choice A"], ["b", "choice B"]]) {
      f.engine.registerAgent(new MockAgent(id!, () => ({ summary: id!, facts: [{ key: "contract", value: value! }] })));
      f.engine.addTask(task(id!, id === "plan" ? [] : ["plan"]));
    }
    f.engine.registerAgent(new MockAgent("review", ({ context }) => {
      assert.equal(context.contract?.value, "combined");
      assert.equal(context.contract?.revision, 3);
      reviewed = true; return { summary: "reviewed" };
    }));
    f.engine.addTask(task("review", ["a", "b"]));
    const snapshot = await f.engine.run("p", 2);
    assert.equal(reviewed, false);
    assert.equal(snapshot.tasks.find((t) => t.id === "review")?.status, "pending");
    assert.equal(snapshot.context.contract?.value, "original");
    assert.equal(snapshot.contextConflicts.length, 2);
    const [a, b] = snapshot.contextConflicts;
    snapshot.context.contract!.value = "tampered snapshot";
    assert.equal(f.engine.snapshot("p").context.contract?.value, "original");
    f.engine.resolveContext("p", a!.id, 1, "accept");
    assert.throws(() => f.engine.resolveContext("p", b!.id, 1, "accept"), /sürümü değişti/);
    f.engine.resolveContext("p", b!.id, 2, "custom", "combined");
    assert.equal(reviewed, false);
    await f.engine.run("p");
    assert.equal(reviewed, true);
    const latest = f.engine.snapshot("p");
    assert.deepEqual(latest.contextHistory.contract?.map((fact) => fact.revision), [1, 2, 3]);
    assert.deepEqual(new Orchestrator(f.journal).snapshot("p"), latest);
  } finally { f.close(); }
});

test("legacy updates gain deterministic versions and keep decisions do not publish a new value", async () => {
  const f = fixture();
  try {
    for (const value of ["old", "current"]) f.journal.append({ type: "context.updated", projectId: "p",
      fact: { key: "contract", value, sourceTaskId: "legacy", updatedAt: "2026-01-01" } });
    const engine = new Orchestrator(f.journal);
    engine.createProject({ id: "other", workspaceRoot: f.root });
    engine.registerAgent(new MockAgent("a", () => ({ summary: "proposal", facts: [{ key: "contract", value: "replacement" }] })));
    engine.addTask(task("a"));
    const result = await engine.run("p");
    const conflict = result.contextConflicts[0]!;
    assert.equal(result.context.contract?.revision, 2);
    assert.equal(conflict.baseRevision, 2);
    assert.throws(() => engine.resolveContext("other", conflict.id, 2, "accept"), /bulunamadı/);
    engine.resolveContext("p", conflict.id, 2, "keep");
    assert.equal(engine.snapshot("p").context.contract?.value, "current");
    assert.equal(engine.snapshot("p").contextHistory.contract?.length, 2);
    assert.throws(() => engine.resolveContext("p", conflict.id, 2, "accept"), /bulunamadı/);
    const replay = new Orchestrator(f.journal);
    assert.equal(replay.snapshot("p").contextConflicts[0]?.resolution?.choice, "keep");
    assert.deepEqual(replay.snapshot("other").contextHistory, {});
  } finally { f.close(); }
});

test("direct adapters cannot publish duplicate or reserved decision keys", async () => {
  const f = fixture();
  try {
    const outputs = [[{ key: "system.secret", value: "bad" }], [{ key: "x", value: "a" }, { key: "x", value: "b" }]];
    outputs.forEach((facts, index) => {
      const id = `a${index}`;
      f.engine.registerAgent(new MockAgent(id, () => ({ summary: "invalid", facts })));
      f.engine.addTask(task(id));
    });
    const snapshot = await f.engine.run("p");
    assert.ok(snapshot.tasks.every((task) => task.status === "failed"));
    assert.deepEqual(snapshot.context, {});
    assert.deepEqual(snapshot.contextConflicts, []);
  } finally { f.close(); }
});

test("context resolution cannot change a running wave's accepted inputs", async () => {
  const f = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let proposed!: () => void;
  const proposal = new Promise<void>((resolve) => { proposed = resolve; });
  try {
    f.engine.registerAgent(new MockAgent("plan", () => ({ summary: "base", facts: [{ key: "contract", value: "base" }] })));
    f.engine.addTask(task("plan")); await f.engine.run("p");
    f.engine.registerAgent(new MockAgent("a", () => ({ summary: "change", facts: [{ key: "contract", value: "new" }] })));
    f.engine.registerAgent(new MockAgent("b", async () => { await waiting; return { summary: "done" }; }));
    f.engine.addTask(task("a")); f.engine.addTask(task("b"));
    f.engine.subscribe((notice) => { if (notice.kind === "event" && notice.event.payload.type === "context.conflict.created") proposed(); });
    const run = f.engine.run("p", 2); await proposal;
    const id = f.engine.snapshot("p").contextConflicts[0]!.id;
    assert.throws(() => f.engine.resolveContext("p", id, 1, "accept"), /çalışan görevleri/);
    release(); await run;
    f.engine.resolveContext("p", id, 1, "accept");
    assert.equal(f.engine.snapshot("p").context.contract?.revision, 2);
  } finally { release?.(); f.close(); }
});

test("file-producing proposals wait for digest approval and CLI decisions persist without provider execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-context-git-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "src/a.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  const key = createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 16);
  const journal = new SqliteJournal(join(root, ".agentmesh-data", key, "events.sqlite"));
  try {
    const engine = new Orchestrator(journal, new WorktreeManager());
    engine.createProject({ id: "p", workspaceRoot: repo });
    journal.append({ type: "context.updated", projectId: "p", fact: { key: "contract", value: "base", sourceTaskId: "legacy", updatedAt: "" } });
    const replay = new Orchestrator(journal, new WorktreeManager());
    replay.registerAgent({ id: "a", provider: "fixture", connection: "cli", async execute({ workspaceRoot }) {
      writeFileSync(join(workspaceRoot, "src/a.txt"), "new");
      return { summary: "changed", facts: [{ key: "contract", value: "new" }] };
    } });
    replay.addTask(task("a"));
    const before = await replay.run("p");
    assert.equal(before.tasks[0]?.status, "pending_review");
    assert.equal(before.contextConflicts.length, 0);
    replay.approveTask("a", before.tasks[0]!.review!.digest);
    assert.equal(replay.snapshot("p").context.contract?.value, "base");
    const id = replay.snapshot("p").contextConflicts[0]!.id;
    journal.close();
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: repo, agents: [{ id: "a", provider: "codex" }], tasks: [task("a")] }));
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "--config", config, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(cli("--context").context.contract.revision, 1);
    assert.equal(cli("--resolve-context", id, "--revision", "1", "--choice", "accept").resolved, id);
    assert.equal(cli("--context").context.contract.value, "new");
    assert.equal(cli("--context").contextHistory.contract.length, 2);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});
