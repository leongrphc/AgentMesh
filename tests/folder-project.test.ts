import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";
import { folderConfig, readRecent, rememberRecent, resolveRepository } from "../src/desktop/folder-project.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const commit = (cwd: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

test("folder opening explains missing repositories and missing commits", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-folder-"));
  try {
    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.throws(() => resolveRepository(plain), /Git deposu değil/);
    assert.throws(() => resolveRepository(join(root, "missing")), /bulunamadı/);
    const empty = join(root, "empty");
    git(root, "init", "-q", empty);
    assert.throws(() => resolveRepository(empty), /henüz commit yok/);
    writeFileSync(join(empty, "a.txt"), "a");
    git(empty, "add", "-A"); commit(empty);
    mkdirSync(join(empty, "sub"));
    assert.equal(resolveRepository(join(empty, "sub")).toLowerCase(), resolveRepository(empty).toLowerCase());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("folder config is stable per repository and starts with Claude and Codex agents and no tasks", () => {
  const a = folderConfig("C:\\work\\Shop App");
  assert.equal(a.projectId, folderConfig("C:\\work\\Shop App").projectId);
  assert.match(a.projectId, /^shop-app-[0-9a-f]{6}$/);
  assert.notEqual(a.projectId, folderConfig("C:\\other\\Shop App").projectId);
  const withProfiles = folderConfig("C:\\work\\Shop App", [{ name: "codex1", path: "C:\\p\\codex1" }, { name: "codex2", path: "C:\\p\\codex2" }]);
  assert.equal(withProfiles.agents.find((agent) => agent.provider === "codex")?.codexHome, "C:\\p\\codex1");
  assert.equal(withProfiles.agents.find((agent) => agent.provider === "claude")?.codexHome, undefined);
  assert.deepEqual(a.agents.map((agent) => [agent.id, agent.provider, agent.transport]), [["claude", "claude", undefined], ["codex", "codex", "app-server"]]);
  assert.deepEqual(a.tasks, []);
});

test("recent projects are deduplicated, newest first and tolerate a corrupt file", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-recent-"));
  try {
    assert.deepEqual(readRecent(root), []);
    rememberRecent(root, "C:\\a"); rememberRecent(root, "C:\\b"); rememberRecent(root, "c:\\A");
    const expected = process.platform === "win32" ? ["c:\\A", "C:\\b"] : ["c:\\A", "C:\\b", "C:\\a"];
    assert.deepEqual(readRecent(root).map((item) => item.path), expected);
    writeFileSync(join(root, "recent-projects.json"), "{broken");
    assert.deepEqual(readRecent(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("desktop opens a plain Git folder, persists UI tasks and reopens it as the last project", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-open-folder-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  git(root, "init", "-q", repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(repo, "add", "-A"); commit(repo);
  let service = new DesktopService(data);
  try {
    const state = service.openFolder(repo);
    assert.equal(state.source, "folder");
    assert.equal(state.demo, false);
    assert.equal(state.uncommittedChanges, false);
    assert.match(state.integrationBranch ?? "", /^agentmesh\/integration-[0-9a-f]{8}$/);
    assert.deepEqual(state.defaultAllowedPaths, ["**"]);
    assert.equal(state.recent[0]?.name, "repo");
    service.createTask({ id: "first", title: "First", instruction: "Do it", agentId: "codex", dependsOn: [], allowedPaths: ["**"] });
    await service.close();

    writeFileSync(join(repo, "dirty.txt"), "uncommitted");
    service = new DesktopService(data);
    assert.equal(service.openLastProject(), true);
    assert.deepEqual(service.state().snapshot.tasks.map((task) => [task.id, task.status]), [["first", "pending"]]);
    assert.equal(service.state().uncommittedChanges, true);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("projects opened with an older default agent list keep their agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-old-agents-"));
  const repo = join(root, "repo");
  git(root, "init", "-q", repo);
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "-A"); commit(repo);
  const { SqliteJournal } = await import("../src/core/sqlite-journal.js");
  const { repositoryKey } = await import("../src/desktop/folder-project.js");
  const { Orchestrator } = await import("../src/core/orchestrator.js");
  const { WorktreeManager } = await import("../src/core/worktrees.js");
  const resolved = resolveRepository(repo);
  const config = folderConfig(resolved);
  const legacy = [{ id: "codex", provider: "codex" as const, transport: "app-server" as const }];
  mkdirSync(join(root, "data", "repos", repositoryKey(resolved)), { recursive: true });
  const journal = new SqliteJournal(join(root, "data", "repos", repositoryKey(resolved), "events.sqlite"));
  const engine = new Orchestrator(journal, new WorktreeManager());
  engine.createProject({ id: config.projectId, workspaceRoot: resolved });
  engine.configureAgents(config.projectId, legacy, legacy);
  journal.close();
  const service = new DesktopService(join(root, "data"));
  try {
    assert.deepEqual(service.openFolder(repo).agents.map((agent) => agent.id), ["codex"]);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("a vanished last project falls back without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-last-"));
  const service = new DesktopService(root);
  try {
    rememberRecent(root, join(root, "gone"));
    assert.equal(service.openLastProject(), false);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
