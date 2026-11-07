import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configJournalPath } from "../src/core/journal-location.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import type { AgentAdapter } from "../src/core/contracts.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const text = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const commitAll = (cwd: string, message: string) => { git(cwd, "add", "-A"); git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message); };

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "mesh-location-"));
  const repo = join(parent, "repo");
  git(parent, "init", "-q", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  commitAll(repo, "init");
  return { parent, repo: realpathSync(repo), cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test("task and integration worktrees stay inside the selected folder and are hidden from Git", () => {
  const { parent, repo, cleanup } = fixture();
  try {
    const lease = new WorktreeManager().prepare(repo, "task-1");
    assert.ok(lease.path.toLowerCase().startsWith(join(repo, ".agentmesh", "worktrees").toLowerCase()), lease.path);
    assert.ok(existsSync(join(repo, ".agentmesh", "worktrees", "integration")));
    assert.deepEqual(readdirSync(parent), ["repo"], "nothing may be written next to the repository");
    assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "", "the main repository stays clean");
    const exclude = readFileSync(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"), "utf8");
    assert.equal(exclude.split(/\r?\n/).filter((line) => line === "/.agentmesh/").length, 1);
    new WorktreeManager().prepare(repo, "task-2");
    const again = readFileSync(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"), "utf8");
    assert.equal(again.split(/\r?\n/).filter((line) => line === "/.agentmesh/").length, 1, "exclude entry is added once");
    assert.equal(new WorktreeManager().reopen(repo, lease).branch, lease.branch);
  } finally { cleanup(); }
});

test("worktrees created next to the repository by earlier versions keep working", () => {
  const { parent, repo, cleanup } = fixture();
  try {
    const manager = new WorktreeManager();
    const legacyRoot = join(parent, ".agentmesh-worktrees", createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 16));
    const integration = manager.integration(repo);
    git(repo, "worktree", "remove", "--force", integration.path);
    git(repo, "worktree", "add", join(legacyRoot, "integration"), integration.branch);
    // A clean legacy integration worktree is moved inside the repository…
    assert.equal(realpathSync(manager.integration(repo).path), realpathSync(join(repo, ".agentmesh", "worktrees", "integration")));
    assert.ok(!existsSync(join(legacyRoot, "integration")));
    // …but one with work in progress is left where it is.
    git(repo, "worktree", "move", join(repo, ".agentmesh", "worktrees", "integration"), join(legacyRoot, "integration"));
    writeFileSync(join(legacyRoot, "integration", "wip.txt"), "unfinished");
    assert.equal(realpathSync(manager.integration(repo).path), realpathSync(join(legacyRoot, "integration")), "dirty legacy worktree stays");
    rmSync(join(legacyRoot, "integration", "wip.txt"));
    git(repo, "worktree", "add", "-b", "agentmesh/legacy-task", join(legacyRoot, "task"), integration.branch);
    assert.equal(manager.reopen(repo, { path: join(legacyRoot, "task"), branch: "agentmesh/legacy-task" }).branch, "agentmesh/legacy-task");
    mkdirSync(join(parent, "elsewhere"));
    git(repo, "worktree", "add", "-b", "agentmesh/rogue", join(parent, "elsewhere", "x"), integration.branch);
    assert.throws(() => manager.reopen(repo, { path: join(parent, "elsewhere", "x"), branch: "agentmesh/rogue" }), /Beklenmeyen worktree konumu/);
  } finally { cleanup(); }
});

test("approved work is applied to the checked-out branch, refusing dirty trees and undoing conflicts", () => {
  const { repo, cleanup } = fixture();
  try {
    const manager = new WorktreeManager();
    assert.equal(manager.pendingIntegration(repo), 0);
    assert.throws(() => manager.applyIntegration(repo), /yeni onaylı değişiklik yok/);
    const integration = manager.integration(repo);
    writeFileSync(join(integration.path, "b.txt"), "from agent\n");
    commitAll(integration.path, "agent work");
    assert.equal(manager.pendingIntegration(repo), 1);

    writeFileSync(join(repo, "a.txt"), "dirty\n");
    assert.throws(() => manager.applyIntegration(repo), /commit edilmemiş/);
    git(repo, "checkout", "--", "a.txt");

    const fast = manager.applyIntegration(repo);
    assert.deepEqual({ commits: fast.commits, fastForward: fast.fastForward }, { commits: 1, fastForward: true });
    assert.equal(text(join(repo, "b.txt")), "from agent\n");
    assert.equal(manager.pendingIntegration(repo), 0);

    writeFileSync(join(integration.path, "c.txt"), "agent 2\n"); commitAll(integration.path, "agent 2");
    writeFileSync(join(repo, "d.txt"), "user\n"); commitAll(repo, "user work");
    const merged = manager.applyIntegration(repo);
    assert.equal(merged.fastForward, false);
    assert.ok(existsSync(join(repo, "c.txt")) && existsSync(join(repo, "d.txt")));

    writeFileSync(join(integration.path, "a.txt"), "agent version\n"); commitAll(integration.path, "agent edits a");
    writeFileSync(join(repo, "a.txt"), "user version\n"); commitAll(repo, "user edits a");
    const head = git(repo, "rev-parse", "HEAD");
    assert.throws(() => manager.applyIntegration(repo), /çakışma çıktı; birleştirme geri alındı/);
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(text(join(repo, "a.txt")), "user version\n");
  } finally { cleanup(); }
});

test("config journals live inside the repository unless an earlier one exists next to it", () => {
  const { parent, repo, cleanup } = fixture();
  try {
    assert.equal(configJournalPath(repo), join(repo, ".agentmesh", "data", "events.sqlite"));
    assert.equal(git(repo, "status", "--porcelain"), "");
    const key = createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 16);
    const legacy = join(parent, ".agentmesh-data", key, "events.sqlite");
    mkdirSync(join(parent, ".agentmesh-data", key), { recursive: true });
    writeFileSync(legacy, "");
    assert.equal(configJournalPath(repo), legacy);
  } finally { cleanup(); }
});

test("an agent taking over a task continues in the same worktree with the previous agent's partial work", async () => {
  const { repo, cleanup } = fixture();
  const { Orchestrator } = await import("../src/core/orchestrator.js");
  const { Journal } = await import("../src/core/journal.js");
  try {
    const engine = new Orchestrator(new Journal(join(repo, ".agentmesh", "events.jsonl")), new WorktreeManager());
    engine.createProject({ id: "p", workspaceRoot: repo });
    const workspaces: string[] = [];
    // CLI-like adapters: mock adapters deliberately run without a worktree.
    const cli = (id: string, execute: AgentAdapter["execute"]): AgentAdapter => ({ id, provider: id, connection: "cli", execute });
    engine.registerAgent(cli("codex", async ({ workspaceRoot }) => {
      workspaces.push(workspaceRoot);
      writeFileSync(join(workspaceRoot, "part1.txt"), "codex yazdı\n");
      throw new Error("durduruldu");
    }));
    engine.registerAgent(cli("claude", async ({ workspaceRoot }) => {
      workspaces.push(workspaceRoot);
      assert.equal(text(join(workspaceRoot, "part1.txt")), "codex yazdı\n", "previous agent's work is still there");
      writeFileSync(join(workspaceRoot, "part2.txt"), "claude tamamladı\n");
      return { summary: "tamam" };
    }));
    engine.addTask({ id: "feature", projectId: "p", agentId: "codex", title: "f", instruction: "f", dependsOn: [], allowedPaths: ["**"] });
    await engine.run("p");
    engine.reassignTask("feature", "claude");
    const result = await engine.run("p");
    assert.equal(result.tasks[0]!.status, "pending_review");
    assert.equal(workspaces[0], workspaces[1], "same worktree for both agents");
    const inspection = new WorktreeManager().inspectTask(repo, result.tasks[0]!.worktree!, ["**"]);
    assert.deepEqual(inspection.changedPaths.sort(), ["part1.txt", "part2.txt"]);
  } finally { cleanup(); }
});

test("review diffs return both sides of a changed file and refuse paths outside the worktree", () => {
  const { repo, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "gone.txt"), "eski\n");
    commitAll(repo, "more");
    const manager = new WorktreeManager();
    const lease = manager.prepare(repo, "diff-task");
    writeFileSync(join(lease.path, "a.txt"), "b\n");
    writeFileSync(join(lease.path, "new.ts"), "export {};\n");
    writeFileSync(join(lease.path, "image.bin"), Buffer.from([0, 1, 2, 3]));
    rmSync(join(lease.path, "gone.txt"));
    const changed = manager.fileVersions(repo, lease, "a.txt");
    assert.deepEqual([changed.original?.replace(/\r\n/g, "\n"), changed.modified], ["a\n", "b\n"]);
    assert.deepEqual(manager.fileVersions(repo, lease, "new.ts"), { original: null, modified: "export {};\n" });
    assert.deepEqual(manager.fileVersions(repo, lease, "gone.txt").modified, null);
    assert.equal(manager.fileVersions(repo, lease, "image.bin").skipped, "binary");
    assert.throws(() => manager.fileVersions(repo, lease, "../outside.txt"), /Geçersiz dosya yolu/);
    assert.throws(() => manager.fileVersions(repo, lease, "C:/Windows/win.ini"), /Geçersiz dosya yolu/);
  } finally { cleanup(); }
});
