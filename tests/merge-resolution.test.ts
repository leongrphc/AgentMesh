import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Orchestrator } from "../src/core/orchestrator.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import { DesktopService } from "../src/desktop/service.js";
import type { AgentTask } from "../src/core/contracts.js";
import { readConflictFile, writeConflictResolution } from "../src/core/workspace-files.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mesh-merge-"));
  const repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "src", "shared.txt"), "initial\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "initial");
  const key = createHash("sha256").update(process.platform === "win32" ? repo.toLowerCase() : repo).digest("hex").slice(0, 16);
  const journal = new SqliteJournal(join(root, ".agentmesh-data", key, "events.sqlite"));
  const manager = new WorktreeManager();
  const engine = new Orchestrator(journal, manager);
  engine.createProject({ id: "p", workspaceRoot: repo });
  const task = (id: string): AgentTask => ({ id, projectId: "p", agentId: id, title: id, instruction: id, dependsOn: [], allowedPaths: ["src/**"] });
  return { root, repo, journal, manager, engine, task };
}

test("desktop resolves a committed merge conflict across restart and another integration advance with fresh digest approval", async () => {
  const f = fixture();
  const service = new DesktopService(join(f.root, "desktop"));
  try {
    for (const id of ["first", "second"]) {
      f.engine.registerAgent({ id, provider: "test", connection: "cli", async execute({ workspaceRoot }) {
        writeFileSync(join(workspaceRoot, "src", "shared.txt"), `${id}\n`);
        return { summary: id, tests: [{ name: "Agent test", status: "passed" }] };
      } });
      f.engine.addTask(f.task(id));
    }
    const pending = await f.engine.run("p", 2);
    f.engine.approveTask("first", pending.tasks[0]!.review!.digest);
    const originalDigest = pending.tasks[1]!.review!.digest;
    assert.throws(() => f.engine.approveTask("second", originalDigest), /conflict/);
    f.journal.close();
    const config = join(f.root, "config.json");
    writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: f.repo,
      agents: ["first", "second"].map((id) => ({ id, provider: "codex" })), tasks: ["first", "second"].map(f.task) }));
    service.openConfig(config);
    let review = service.review("second");
    assert.deepEqual(review.inspection.changedPaths, ["src/shared.txt"]);
    assert.match(review.inspection.trackedDiff, /second/);
    assert.equal(review.inspection.digest, originalDigest, "committing preserves the reviewed content identity");
    assert.equal(review.merge?.active, false);
    assert.throws(() => service.prepareMergeResolution("second", review.inspection.digest, "0".repeat(40)), /Entegrasyon dalı değişti/);
    review = service.prepareMergeResolution("second", review.inspection.digest, review.merge!.integrationCommit);
    assert.equal(review.merge?.active, true);
    assert.deepEqual(review.merge?.unresolved, ["src/shared.txt"]);
    assert.equal(review.canApprove, false);
    assert.equal(review.testsStale, true);
    await service.close(); service.openConfig(config);
    assert.equal(service.review("second").merge?.active, true);
    let file = service.conflictFile("second", "src/shared.txt");
    assert.match(file.content!, /<<<<<<< HEAD/);
    assert.throws(() => service.resolveConflict("second", file.path, file.content, file.digest), /işaretlerini/);
    assert.throws(() => service.resolveConflict("second", file.path, "resolved\n", "stale"), /disk üzerinde değişti/);
    assert.throws(() => service.conflictFile("second", "../outside"), /çakışma dosyası/);
    review = service.resolveConflict("second", file.path, "resolved\n", file.digest);
    assert.deepEqual(review.merge?.unresolved, []);
    assert.equal(review.canApprove, true);
    assert.throws(() => service.approve("second", originalDigest), /digest/);
    // Another approved change arrived while the human was resolving this task.
    const integration = f.manager.integration(f.repo);
    writeFileSync(join(integration.path, "src", "shared.txt"), "third\n");
    git(integration.path, "add", "."); git(integration.path, "commit", "-m", "another integrated task");
    assert.throws(() => service.approve("second", review.inspection.digest), /conflict/);
    review = service.review("second");
    assert.equal(review.merge?.active, false);
    review = service.prepareMergeResolution("second", review.inspection.digest, review.merge!.integrationCommit);
    file = service.conflictFile("second", "src/shared.txt");
    review = service.resolveConflict("second", file.path, "final resolved\n", file.digest);
    service.approve("second", review.inspection.digest);
    assert.equal(service.state().snapshot.tasks[1]?.status, "completed");
    assert.equal(service.state().snapshot.context["task.second.summary"]?.value, "second");
    assert.equal(readFileSync(join(integration.path, "src", "shared.txt"), "utf8").trim(), "final resolved");
    assert.equal(git(integration.path, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(f.repo, "src", "shared.txt"), "utf8").trim(), "initial");
    assert.equal(git(f.repo, "status", "--porcelain"), "");
  } finally { await service.close(); f.journal.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("agent-created commits remain reviewable and committed out-of-scope changes fail the task", async () => {
  const f = fixture();
  try {
    for (const id of ["valid", "invalid"]) {
      f.engine.registerAgent({ id, provider: "test", connection: "cli", async execute({ workspaceRoot }) {
        writeFileSync(join(workspaceRoot, id === "valid" ? "src/committed.txt" : "OUTSIDE.txt"), "committed\n");
        git(workspaceRoot, "add", "."); git(workspaceRoot, "commit", "-m", "agent commit");
        return { summary: "Committed" };
      } });
      f.engine.addTask(f.task(id));
    }
    const snapshot = await f.engine.run("p", 2);
    assert.equal(snapshot.tasks[0]?.status, "pending_review");
    assert.equal(snapshot.tasks[1]?.status, "failed");
    assert.match(snapshot.tasks[1]?.error ?? "", /İzin verilmeyen/);
    f.engine.approveTask("valid", snapshot.tasks[0]!.review!.digest);
    assert.equal(readFileSync(join(f.manager.integration(f.repo).path, "src/committed.txt"), "utf8").trim(), "committed");
  } finally { f.journal.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("conflict file writes enforce content digests and scope; deletion and missing-file recreation are explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-conflict-file-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.txt"), "current\n");
    const first = readConflictFile(root, "src/a.txt");
    assert.throws(() => writeConflictResolution(root, "src/a.txt", "other", "stale", ["src/**"]), /disk üzerinde/);
    assert.throws(() => writeConflictResolution(root, "src/a.txt", null, first.digest, ["other/**"]), /kapsamı/);
    writeConflictResolution(root, "src/a.txt", null, first.digest, ["src/**"]);
    assert.equal(readConflictFile(root, "src/a.txt").digest, null);
    writeConflictResolution(root, "src/a.txt", "restored\n", null, ["src/**"]);
    assert.equal(readConflictFile(root, "src/a.txt").content, "restored\n");
    assert.throws(() => readConflictFile(root, "../outside"), /korunan/);
    writeFileSync(join(root, "src/b.bin"), Buffer.from([0, 1, 2]));
    const binary = readConflictFile(root, "src/b.bin");
    assert.equal(binary.binary, true);
    writeConflictResolution(root, binary.path, null, binary.digest, ["src/**"], true);
    assert.deepEqual(readFileSync(join(root, "src/b.bin")), Buffer.from([0, 1, 2]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
