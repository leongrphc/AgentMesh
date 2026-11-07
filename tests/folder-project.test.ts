import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";
import { folderConfig, prepareRepository, readRecent, rememberRecent, resolveRepository, unsafeRepositoryRoot } from "../src/desktop/folder-project.js";

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

test("a plain folder becomes a repository whose first commit leaves out dependencies, build output and secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-init-"));
  try {
    const plain = join(root, "plain");
    mkdirSync(join(plain, "src"), { recursive: true });
    mkdirSync(join(plain, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(plain, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(plain, "node_modules", "lib", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(plain, ".env"), "SECRET=1\n");
    writeFileSync(join(plain, ".env.example"), "SECRET=\n");
    const opened = prepareRepository(plain);
    assert.match(opened.notice ?? "", /Git deposu değildi/);
    const committed = git(opened.root, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n").sort();
    assert.deepEqual(committed, [".env.example", "src/app.ts"]);
    assert.equal(git(opened.root, "status", "--porcelain").trim(), "", "excluded files do not show up as changes");
    assert.equal(prepareRepository(plain).notice, undefined, "opening again changes nothing");

    const empty = join(root, "empty");
    git(root, "init", "-q", empty);
    writeFileSync(join(empty, "a.txt"), "a");
    assert.match(prepareRepository(empty).notice ?? "", /hiç commit yoktu/);
    assert.equal(git(empty, "ls-tree", "-r", "--name-only", "HEAD").trim(), "a.txt");
    assert.throws(() => prepareRepository(join(root, "missing")), /bulunamadı/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drive roots, the home folder and Windows itself are never turned into repositories", () => {
  assert.match(unsafeRepositoryRoot(homedir()) ?? "", /kullanıcı klasörü/);
  assert.match(unsafeRepositoryRoot(parse(tmpdir()).root) ?? "", /sürücü/);
  if (process.env.SystemRoot) assert.match(unsafeRepositoryRoot(join(process.env.SystemRoot, "System32")) ?? "", /Windows/);
  assert.equal(unsafeRepositoryRoot(tmpdir()), undefined);
});

test("opening a plain folder in the desktop app reports what was created", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-open-plain-"));
  const folder = join(root, "notes");
  mkdirSync(folder);
  writeFileSync(join(folder, "todo.md"), "- one\n");
  const service = new DesktopService(join(root, "data"));
  try {
    const state = service.openFolder(folder);
    assert.equal(state.source, "folder");
    assert.match(state.openNotice ?? "", /1 dosyayı ilk commit/);
    assert.equal(state.uncommittedChanges, false);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
