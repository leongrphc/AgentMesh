import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Journal } from "../src/core/journal.js";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import { CodexCliAdapter } from "../src/adapters/codex-cli.js";
import { OpenCodeCliAdapter } from "../src/adapters/opencode-cli.js";
import { runJsonlProcess } from "../src/adapters/cli-process.js";
import type { AgentAdapter, AgentTask, AgentExecution, AgentResult } from "../src/core/contracts.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentmesh-it-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "AgentMesh Test");
  git(repo, "config", "user.email", "agentmesh@example.invalid");
  writeFileSync(join(repo, "src", "initial.txt"), "initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function task(id: string, agentId: string, allowedPaths: string[]): AgentTask {
  return {
    id, agentId, projectId: "p", title: id, instruction: `Uygula ${id}`,
    dependsOn: [], allowedPaths,
  };
}

test("SQLite eski JSONL geçmişini taşır; proje/mesaj/context ve tek-yazar kilidi kalıcıdır", () => {
  const f = repoFixture();
  try {
    const old = new Journal(join(f.root, "legacy.jsonl"));
    old.append({ type: "project.created", project: { id: "p", workspaceRoot: f.repo } });
    old.append({ type: "task.created", task: task("one", "agent", ["src/**"]) });
    const db = join(f.root, "data.sqlite");
    const first = new SqliteJournal(db, join(f.root, "legacy.jsonl"));
    assert.equal(first.all().length, 2);
    assert.throws(() => new SqliteJournal(db), /başka bir işlem/);
    first.append({
      type: "context.updated", projectId: "p",
      fact: { key: "api", value: "v1", sourceTaskId: "one", updatedAt: new Date().toISOString() },
    });
    first.close();
    const reopened = new SqliteJournal(db, join(f.root, "legacy.jsonl"));
    const restored = new Orchestrator(reopened);
    assert.equal(restored.snapshot("p").tasks.length, 1);
    assert.equal(restored.snapshot("p").context.api?.value, "v1");
    assert.equal(reopened.all().length, 3);
    reopened.close();
  } finally { f.cleanup(); }
});

test("iki ajan ayrı worktree'de paralel çalışır; onaylı sonuçlar integration'a girer", async () => {
  const f = repoFixture();
  const journal = new SqliteJournal(join(f.root, "agents.sqlite"));
  try {
    const manager = new WorktreeManager();
    const engine = new Orchestrator(journal, manager);
    engine.createProject({ id: "p", workspaceRoot: f.repo });
    const roots: string[] = [];
    let active = 0, maxActive = 0;
    function adapter(id: string): AgentAdapter {
      return {
        id, provider: "test", connection: "cli",
        execute: async ({ workspaceRoot, task }: AgentExecution): Promise<AgentResult> => {
          roots.push(workspaceRoot);
          active++;
          maxActive = Math.max(maxActive, active);
          writeFileSync(join(workspaceRoot, "src", `${task.id}.txt`), `${task.id}\n`);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active--;
          return { summary: `${task.id} hazır`, sessionId: `session-${task.id}` };
        },
      };
    }
    engine.registerAgent(adapter("a"));
    engine.registerAgent(adapter("b"));
    engine.registerAgent({ id: "c", provider: "test", connection: "cli", async execute({ workspaceRoot, context }) {
      assert.equal(readFileSync(join(workspaceRoot, "src", "alpha.txt"), "utf8").replace(/\r\n/g, "\n"), "alpha\n");
      assert.equal(readFileSync(join(workspaceRoot, "src", "beta.txt"), "utf8").replace(/\r\n/g, "\n"), "beta\n");
      assert.equal(context["task.alpha.summary"]?.value, "alpha hazır");
      return { summary: "bağımlı görev onaylı kodu gördü" };
    } });
    engine.addTask(task("alpha", "a", ["src/alpha.txt"]));
    engine.addTask(task("beta", "b", ["src/beta.txt"]));
    engine.addTask({ ...task("followup", "c", ["src/followup.txt"]), dependsOn: ["alpha", "beta"] });
    let result = await engine.run("p", 2);
    assert.equal(maxActive, 2);
    assert.notEqual(roots[0], roots[1]);
    assert.deepEqual(result.tasks.map((item) => item.status), ["pending_review", "pending_review", "pending"]);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    assert.equal(result.tasks[0]?.sessionId, "session-alpha");
    const lease = result.tasks[0]?.worktree;
    assert.ok(lease);
    const inspection = manager.inspect(lease.path, ["src/alpha.txt"]);
    assert.deepEqual(inspection.changedPaths, ["src/alpha.txt"]);
    assert.deepEqual(inspection.violations, []);
    assert.equal(inspection.untrackedPreviews[0]?.preview, "alpha\n");
    assert.equal(manager.reopen(f.repo, lease).branch, lease.branch);
    assert.throws(() => engine.approveTask("alpha", "incorrect-digest"), /digest/);
    const firstDigest = result.tasks[0]?.review?.digest;
    const secondDigest = result.tasks[1]?.review?.digest;
    assert.ok(firstDigest && secondDigest);
    engine.approveTask("alpha", firstDigest);
    engine.approveTask("beta", secondDigest);
    result = await engine.run("p", 2);
    assert.ok(result.tasks.every((item) => item.status === "completed"), JSON.stringify(result.tasks.map(({ id, status, error }) => ({ id, status, error }))));
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    const integration = manager.integration(f.repo);
    assert.equal(readFileSync(join(integration.path, "src", "alpha.txt"), "utf8").replace(/\r\n/g, "\n"), "alpha\n");
    assert.equal(readFileSync(join(integration.path, "src", "beta.txt"), "utf8").replace(/\r\n/g, "\n"), "beta\n");
    const reloaded = new Orchestrator(journal);
    assert.equal(reloaded.snapshot("p").tasks[0]?.worktree?.path, lease.path);
  } finally { journal.close(); f.cleanup(); }
});

test("onaylanan diff değiştirilirse merge reddedilir ve inceleme açık kalır", async () => {
  const f = repoFixture();
  const journal = new SqliteJournal(join(f.root, "agents.sqlite"));
  try {
    const manager = new WorktreeManager();
    const engine = new Orchestrator(journal, manager);
    engine.createProject({ id: "p", workspaceRoot: f.repo });
    engine.registerAgent({ id: "a", provider: "test", connection: "cli", async execute({ workspaceRoot }) {
      writeFileSync(join(workspaceRoot, "src", "feature.txt"), "ilk sürüm\n");
      return { summary: "hazır" };
    } });
    engine.addTask(task("feature", "a", ["src/feature.txt"]));
    const result = (await engine.run("p")).tasks[0];
    assert.equal(result?.status, "pending_review");
    assert.ok(result?.worktree && result.review);
    writeFileSync(join(result.worktree.path, "src", "feature.txt"), "değiştirilmiş\n");
    assert.throws(() => engine.approveTask("feature", result.review!.digest), /Diff onaydan sonra değişmiş/);
    assert.equal(engine.snapshot("p").tasks[0]?.status, "pending_review");
    assert.equal(git(f.repo, "status", "--porcelain"), "");
  } finally { journal.close(); f.cleanup(); }
});

test("aynı satırı değiştiren görev merge conflict üretir; integration ve main korunur", async () => {
  const f = repoFixture();
  const journal = new SqliteJournal(join(f.root, "agents.sqlite"));
  try {
    const manager = new WorktreeManager();
    const engine = new Orchestrator(journal, manager);
    engine.createProject({ id: "p", workspaceRoot: f.repo });
    for (const agentId of ["first", "second"]) {
      engine.registerAgent({ id: agentId, provider: "test", connection: "cli", async execute({ workspaceRoot }) {
        writeFileSync(join(workspaceRoot, "src", "initial.txt"), `${agentId}\n`);
        return { summary: `${agentId} hazır` };
      } });
      engine.addTask(task(agentId, agentId, ["src/initial.txt"]));
    }
    const pending = await engine.run("p", 2);
    const [first, second] = pending.tasks;
    assert.ok(first?.review && second?.review);
    engine.approveTask(first.id, first.review.digest);
    assert.throws(() => engine.approveTask(second.id, second.review!.digest), /conflict/);
    // The conflict is retryable and cannot complete without an explicit resolution.
    assert.throws(() => engine.approveTask(second.id, second.review!.digest), /conflict/);
    assert.equal(engine.snapshot("p").tasks[1]?.status, "pending_review");
    assert.equal(git(manager.integration(f.repo).path, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(manager.integration(f.repo).path, "src", "initial.txt"), "utf8").trim(), "first");
    assert.equal(readFileSync(join(f.repo, "src", "initial.txt"), "utf8").trim(), "initial");
  } finally { journal.close(); f.cleanup(); }
});

test("izin dışı dosya değişikliği görevi başarısız yapar; kanıt worktree'de kalır", async () => {
  const f = repoFixture();
  const journal = new SqliteJournal(join(f.root, "agents.sqlite"));
  try {
    const engine = new Orchestrator(journal, new WorktreeManager());
    engine.createProject({ id: "p", workspaceRoot: f.repo });
    engine.registerAgent({ id: "bad", provider: "test", connection: "cli", async execute(input) {
      writeFileSync(join(input.workspaceRoot, "NOT_ALLOWED.txt"), "unsafe\n");
      return { summary: "yazdım" };
    } });
    engine.addTask(task("bad-task", "bad", ["src/**"]));
    const record = (await engine.run("p")).tasks[0];
    assert.equal(record?.status, "failed");
    assert.match(record?.error ?? "", /İzin verilmeyen dosya/);
    assert.ok(record?.worktree);
    assert.equal(readFileSync(join(record.worktree.path, "NOT_ALLOWED.txt"), "utf8"), "unsafe\n");
    assert.equal(git(f.repo, "status", "--porcelain"), "");
  } finally { journal.close(); f.cleanup(); }
});

test("Codex/OpenCode gerçek CLI komutları güvenli bayraklar ve session ile hazırlanır", async () => {
  const f = repoFixture();
  try {
    const input: AgentExecution = {
      task: task("feature", "worker", ["src/**"]), workspaceRoot: f.repo,
      inbox: [], context: {},
    };
    let captured: string[] = [];
    const codex = new CodexCliAdapter("worker", { model: "gpt-6", runner: async (spec) => {
      captured = spec.args;
      assert.match(spec.stdin ?? "", /İzinli dosya desenleri/);
      return { stderr: "", events: [
        { type: "thread.started", thread_id: "thread-123" },
        { type: "item.completed", item: { type: "agent_message", text: "Kod hazır" } },
      ] };
    } });
    const out = await codex.execute(input);
    assert.equal(out.sessionId, "thread-123");
    assert.equal(out.summary, "Kod hazır");
    assert.ok(captured.includes("workspace-write"));
    assert.ok(!captured.includes("--dangerously-bypass-approvals-and-sandbox"));
    await codex.execute({ ...input, sessionId: "thread-123" });
    assert.ok(captured.includes("resume"));
    assert.ok(captured.includes("thread-123"));

    let opencodeArgs: string[] = [];
    const opencode = new OpenCodeCliAdapter("worker", { runner: async (spec) => {
      opencodeArgs = spec.args;
      return { stderr: "", events: [
        { type: "text", sessionID: "oc-123", part: { text: "Arayüz hazır" } },
      ] };
    } });
    assert.equal((await opencode.execute(input)).sessionId, "oc-123");
    await opencode.execute({ ...input, sessionId: "oc-123" });
    assert.ok(opencodeArgs.includes("--session"));
    assert.ok(!opencodeArgs.includes("--auto"));
  } finally { f.cleanup(); }
});

test("JSONL process runner gerçekten ayrı işlem açıp olayları okur", async () => {
  const updates: Array<{ channel: string; data: unknown }> = [];
  const result = await runJsonlProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({type:'text',part:{text:'ok'}})+'\\n'); process.stderr.write('diagnostic')"],
    cwd: process.cwd(), timeoutMs: 5000,
    onOutput: (event) => { updates.push(event); },
  });
  assert.equal(result.events[0]?.type, "text");
  assert.ok(updates.some((item) => item.channel === "stdout" && typeof item.data === "object"));
  assert.ok(updates.some((item) => item.channel === "stderr" && item.data === "diagnostic"));
});

test("JSONL CLI işlemi canlı olaydan iptal edilir; uzun süreç durdurulur", async () => {
  const abort = new AbortController();
  let outputs = 0;
  const start = Date.now();
  await assert.rejects(runJsonlProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({type:'progress'})+'\\n'); setInterval(() => {}, 1000)"],
    cwd: process.cwd(), signal: abort.signal, timeoutMs: 5000,
    onOutput: (event) => {
      outputs++;
      if (event.channel === "stdout") abort.abort();
    },
  }), /iptal edildi/);
  assert.equal(outputs, 1);
  assert.ok(Date.now() - start < 4500);
});
