import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { verifyJournalArchive } from "../src/core/journal-archive.js";
import { Orchestrator } from "../src/core/orchestrator.js";

test("verified archive preserves raw history and sequence gaps, never overwrites and supports recovery on a copy", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-archive-"));
  const path = join(root, "source.sqlite"), archive = join(root, "archive.sqlite");
  let journal = new SqliteJournal(path);
  try {
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: root } });
    journal.append({ type: "task.created", task: { id: "t", projectId: "p", agentId: "a", title: "Task", instruction: "private instruction", allowedPaths: [], dependsOn: [] } });
    journal.append({ type: "task.started", projectId: "p", taskId: "t" });
    journal.close();
    const prepare = new DatabaseSync(path); prepare.exec("UPDATE events SET sequence = sequence + 100"); prepare.close();
    journal = new SqliteJournal(path);
    const original = journal.all();
    const result = journal.archive(archive);
    assert.equal(result.eventCount, 3);
    assert.equal(result.firstSequence, 101); assert.equal(result.lastSequence, 103);
    assert.deepEqual(journal.all(), original);
    assert.equal(verifyJournalArchive(archive).digest, result.digest);
    assert.equal(existsSync(archive + ".lock"), false);
    const bytes = readFileSync(archive);
    assert.throws(() => journal.archive(archive), /zaten mevcut/);
    assert.throws(() => journal.archive(path), /zaten mevcut/);
    assert.deepEqual(readFileSync(archive), bytes);
    const restoredPath = join(root, "restored.sqlite"); copyFileSync(archive, restoredPath);
    const restored = new SqliteJournal(restoredPath);
    try {
      assert.deepEqual(restored.all(), original);
      assert.equal(new Orchestrator(restored).snapshot("p").tasks[0]!.status, "needs_review");
    } finally { restored.close(); }
    assert.equal(verifyJournalArchive(archive).digest, result.digest);
    const tamper = new DatabaseSync(archive);
    tamper.prepare("UPDATE events SET payload = ? WHERE sequence = 103").run(JSON.stringify({ type: "task.completed", projectId: "p", taskId: "t", summary: "forged" }));
    tamper.close();
    assert.throws(() => verifyJournalArchive(archive), /doğrulaması başarısız/);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("empty archives verify; missing or changed manifests and incompatible schema are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-archive-empty-"));
  const journal = new SqliteJournal(join(root, "source.sqlite"));
  try {
    const path = join(root, "empty.sqlite");
    assert.equal(journal.archive(path).eventCount, 0);
    const edit = new DatabaseSync(path);
    edit.exec("UPDATE archive_manifest SET manifest = json_set(manifest, '$.eventCount', 1)"); edit.close();
    assert.throws(() => verifyJournalArchive(path), /eventCount/);
    assert.throws(() => verifyJournalArchive(join(root, "source.sqlite")), /archive_manifest/);
    const future = new DatabaseSync(path); future.exec("PRAGMA user_version=99"); future.close();
    assert.throws(() => verifyJournalArchive(path), /şeması/);
    // Inject a source read failure after destination creation: only the owned partial file may be removed.
    const broken = new DatabaseSync(join(root, "source.sqlite")); broken.exec("DROP TABLE events"); broken.close();
    const partial = join(root, "failed.sqlite");
    assert.throws(() => journal.archive(partial), /events/);
    assert.equal(existsSync(partial), false);
    assert.equal(existsSync(partial + ".lock"), false);
    assert.equal(existsSync(join(root, "source.sqlite")), true);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI archives without task recovery and verifies without config or providers", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-archive-cli-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init"], { stdio: "pipe" });
  const key = createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 16);
  const path = join(root, ".agentmesh-data", key, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    journal.append({ type: "project.created", project: { id: "p", workspaceRoot: repo } });
    journal.append({ type: "task.created", task: { id: "t", projectId: "p", agentId: "a", title: "Task", instruction: "Task", allowedPaths: [], dependsOn: [] } });
    journal.append({ type: "task.started", projectId: "p", taskId: "t" });
    journal.close();
    const config = join(root, "config.json"), archive = join(root, "cli.sqlite");
    writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: repo, agents: [], tasks: [] }));
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const result = cli("--config", config, "--archive", archive);
    assert.equal(result.archived, true); assert.equal(result.eventCount, 3);
    assert.equal(cli("--verify-archive", archive).digest, result.digest);
    assert.throws(() => cli("--verify-archive", archive, "--execute"));
    const source = new SqliteJournal(path);
    try { assert.equal(source.all().length, 3); assert.equal(source.all()[2]!.payload.type, "task.started"); }
    finally { source.close(); }
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});
