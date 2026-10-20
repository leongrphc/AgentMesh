import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync, renameSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SqliteJournal } from "../src/core/sqlite-journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { maintainJournal } from "../src/core/journal-maintenance.js";
import { validate } from "../src/core/config.js";
import { DesktopService } from "../src/desktop/service.js";
import { MockAgent } from "../src/adapters/mock.js";
import { DatabaseSync } from "node:sqlite";

const policy = { maxActiveEvents: 100 };

test("maintenance validates opt-in policy, rotates at the active threshold and preserves earlier archives", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-maintenance-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const config = { projectId: "p", repoPath: root, agents: [], tasks: [] };
    for (const value of [null, [], {}, { maxActiveEvents: 99 }, { maxActiveEvents: Infinity }, { maxActiveEvents: 100.1 },
      { maxActivePayloadBytes: 1023 }, { maxActivePayloadBytes: 1024 ** 4 + 1 }, { maxActiveAgeHours: 0 }, { maxActiveAgeHours: 1.5 },
      { maxActiveAgeHours: 87601 }, { maxActiveEvents: undefined }, { ...policy, keepManagedArchives: 0 },
      { keepManagedArchives: 1 }, { ...policy, deleteHistory: true }]) {
      assert.throws(() => validate({ ...config, journalMaintenance: value as never }), /journalMaintenance/);
    }
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    assert.equal(maintainJournal(journal, engine, path).status, "disabled");
    assert.equal(maintainJournal(journal, engine, path, policy).status, "below_threshold");
    assert.equal(journal.loadCheckpoint(), undefined);
    for (let i = 0; i < 99; i++) engine.sendMessage("p", { to: "*", kind: "progress", body: String(i), idempotencyKey: `first-${i}` });
    assert.equal(journal.activeEventCount(), 100);
    const before = engine.snapshot("p");
    assert.equal(maintainJournal(journal, engine, path, policy).status, "compacted");
    assert.equal(journal.activeEventCount(), 0);
    const archive = readdirSync(join(root, "archives")).filter(name => name.endsWith(".sqlite"))[0]!;
    assert.equal(maintainJournal(journal, engine, path, policy).status, "below_threshold");
    assert.deepEqual(new Orchestrator(journal).snapshot("p"), before);
    for (let i = 0; i < 100; i++) engine.sendMessage("p", { to: "*", kind: "progress", body: String(i), idempotencyKey: `second-${i}` });
    assert.equal(maintainJournal(journal, engine, path, policy).status, "compacted");
    assert.equal(readdirSync(join(root, "archives")).filter(name => name.endsWith(".sqlite")).length, 2);
    assert.ok(existsSync(join(root, "archives", archive)));
    assert.equal(new Orchestrator(journal).snapshot("p").messages.length, 199);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("managed retention removes only retired owned copies, survives reopen and preserves complete replay", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-retention-")), path = join(root, "events.sqlite"), directory = join(root, "archives");
  let journal = new SqliteJournal(path);
  try {
    let engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    const rotate = (key: string) => {
      engine.sendMessage("p", { to: "*", kind: "progress", body: "x".repeat(2000), idempotencyKey: key });
      const result = maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024 });
      assert.equal(result.status, "compacted");
      if (result.status !== "compacted") throw new Error("Expected rotation");
      return result.archive.path;
    };
    const first = rotate("one");
    const manual = join(directory, "manual-export.sqlite"); journal.archive(manual);
    const second = rotate("two");
    assert.ok(existsSync(first));
    journal.close(); journal = new SqliteJournal(path); engine = new Orchestrator(journal);
    const expected = engine.snapshot("p");
    const pruned = maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024, keepManagedArchives: 1 });
    assert.equal(pruned.status, "below_threshold");
    if (pruned.status !== "below_threshold") throw new Error("Unexpected rotation");
    assert.equal(pruned.retention?.removed, 1);
    assert.ok(!existsSync(first)); assert.ok(existsSync(second)); assert.ok(existsSync(manual));
    assert.deepEqual(new Orchestrator(journal).snapshot("p"), expected);
    engine.sendMessage("p", { to: "*", kind: "progress", body: "z".repeat(2000), idempotencyKey: "three" });
    const third = maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024, keepManagedArchives: 1 });
    assert.equal(third.status, "compacted");
    if (third.status !== "compacted") throw new Error("Expected rotation");
    assert.equal(third.retention?.removed, 1);
    assert.ok(!existsSync(second)); assert.ok(existsSync(third.archive.path)); assert.ok(existsSync(manual));
    journal.close(); journal = new SqliteJournal(path);
    assert.equal(new Orchestrator(journal).snapshot("p").messages.length, 3);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retention preserves locked or modified copies and refuses to prune without a verified current archive", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-retention-guards-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      engine.sendMessage("p", { to: "*", kind: "progress", body: "x".repeat(2000), idempotencyKey: String(i) });
      const result = maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024 });
      if (result.status !== "compacted") throw new Error("Expected rotation");
      paths.push(result.archive.path);
    }
    writeFileSync(paths[0]! + ".lock", "in use");
    const modify = (file: string) => {
      const db = new DatabaseSync(file);
      try { db.exec("UPDATE archive_manifest SET manifest = '{}'"); } finally { db.close(); }
    };
    modify(paths[1]!);
    const result = journal.pruneManagedArchives(join(root, "archives"), 1);
    assert.equal(result.removed, 0); assert.equal(result.errors.length, 2);
    assert.ok(paths.every(file => existsSync(file)));
    modify(paths[2]!);
    assert.throws(() => journal.pruneManagedArchives(join(root, "archives"), 1), /manifesti/);
    assert.ok(paths.every(file => existsSync(file)));
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retention rejects registered paths outside its directory without removing the file", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-retention-scope-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      engine.sendMessage("p", { to: "*", kind: "progress", body: "x".repeat(2000), idempotencyKey: String(i) });
      const result = maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024 });
      if (result.status !== "compacted") throw new Error("Expected rotation");
      paths.push(result.archive.path);
    }
    const outside = join(root, "outside.sqlite");
    renameSync(paths[0]!, outside);
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE managed_archives SET path = ? WHERE path = ?").run(outside, paths[0]!); } finally { db.close(); }
    const result = journal.pruneManagedArchives(join(root, "archives"), 1);
    assert.equal(result.removed, 0);
    assert.match(result.errors[0]!, /klasör dışında/);
    assert.ok(existsSync(outside)); assert.ok(existsSync(paths[1]!));
    assert.equal(new Orchestrator(journal).snapshot("p").messages.length, 2);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retention rejects directory aliases and dangling sidecar links without retiring history", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-retention-links-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      engine.sendMessage("p", { to: "*", kind: "progress", body: "x".repeat(2000), idempotencyKey: String(i) });
      const result = maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024 });
      if (result.status !== "compacted") throw new Error("Expected rotation");
      paths.push(result.archive.path);
    }
    const directory = join(root, "archives"), alias = join(root, "alias");
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => journal.pruneManagedArchives(alias, 1), /bağlantı üzerinden/);
    const sidecar = paths[0]! + "-wal";
    rmSync(sidecar, { force: true });
    symlinkSync(join(root, "missing-target"), sidecar, process.platform === "win32" ? "junction" : "dir");
    assert.equal(existsSync(sidecar), false);
    assert.equal(lstatSync(sidecar).isSymbolicLink(), true);
    const result = journal.pruneManagedArchives(directory, 1);
    assert.equal(result.removed, 0);
    assert.match(result.errors[0]!, /normal dosya değil/);
    assert.ok(paths.every(file => existsSync(file)));
    assert.equal(lstatSync(sidecar).isSymbolicLink(), true);
    assert.ok(!existsSync(paths[0]! + ".lock"));
    assert.equal(new Orchestrator(journal).snapshot("p").messages.length, 2);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("payload policy measures UTF-8 event content and triggers independently of event count", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-maintenance-bytes-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    engine.sendMessage("p", { to: "*", kind: "progress", body: "şğ🙂".repeat(1500), idempotencyKey: "large" });
    const payloadBytes = journal.all().reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event.payload)), 0);
    assert.equal(journal.activeStorageStats(true, false).payloadBytes, payloadBytes);
    assert.ok(payloadBytes > journal.all().reduce((total, event) => total + JSON.stringify(event.payload).length, 0));
    assert.equal(maintainJournal(journal, engine, path, { maxActivePayloadBytes: payloadBytes + 1 }).status, "below_threshold");
    const result = maintainJournal(journal, engine, path, { maxActiveEvents: 100, maxActivePayloadBytes: payloadBytes });
    assert.equal(result.status, "compacted");
    if (result.status === "compacted") assert.deepEqual(result.reasons, ["payload_bytes"]);
    assert.equal(journal.activeStorageStats(true, false).payloadBytes, 0);
    assert.equal(maintainJournal(journal, engine, path, { maxActivePayloadBytes: 1024 }).status, "below_threshold");
    assert.equal(new Orchestrator(journal).snapshot("p").messages[0]!.body, "şğ🙂".repeat(1500));
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("age policy respects exact boundary, excludes archives and rejects invalid event times", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-maintenance-age-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    const at = Date.parse(journal.all()[0]!.at);
    assert.equal(journal.activeStorageStats(false, true).oldestEventAtMs, at);
    assert.equal(maintainJournal(journal, engine, path, { maxActiveAgeHours: 1 }, at - 1).status, "below_threshold");
    assert.equal(maintainJournal(journal, engine, path, { maxActiveAgeHours: 1 }, at + 3600000 - 1).status, "below_threshold");
    const result = maintainJournal(journal, engine, path, { maxActiveAgeHours: 1, maxActiveEvents: 100 }, at + 3600000);
    assert.equal(result.status, "compacted");
    if (result.status === "compacted") assert.deepEqual(result.reasons, ["age"]);
    assert.equal(maintainJournal(journal, engine, path, { maxActiveAgeHours: 1 }, at + 7200000).status, "below_threshold");
    engine.sendMessage("p", { to: "*", kind: "progress", body: "tail", idempotencyKey: "new" });
    const editor = new DatabaseSync(path);
    try { editor.prepare("UPDATE events SET at = 'invalid-time'").run(); } finally { editor.close(); }
    assert.throws(() => maintainJournal(journal, engine, path, { maxActiveAgeHours: 1 }), /olay zamanı geçersiz/);
    assert.equal(journal.activeEventCount(), 1);
    assert.equal(new Orchestrator(journal).snapshot("p").messages[0]!.body, "tail");
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("maintenance refuses active execution and failed archive creation preserves authoritative events", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-maintenance-busy-")), path = join(root, "events.sqlite");
  const journal = new SqliteJournal(path);
  let finish!: () => void;
  let running: Promise<unknown> | undefined;
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: root });
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    engine.registerAgent(new MockAgent("a", async () => { ready(); await wait; return { summary: "done" }; }));
    engine.addTask({ id: "t", projectId: "p", agentId: "a", title: "Task", instruction: "Task", dependsOn: [], allowedPaths: [] });
    for (let i = 0; i < 100; i++) engine.sendMessage("p", { to: "*", kind: "progress", body: String(i), idempotencyKey: String(i) });
    running = engine.run("p"); await entered;
    assert.throws(() => maintainJournal(journal, engine, path, policy), /çalışan görevleri/);
    assert.ok(!existsSync(join(root, "archives")));
    finish(); await running;
    const before = journal.all();
    writeFileSync(join(root, "archives"), "not a directory");
    assert.throws(() => maintainJournal(journal, engine, path, policy));
    assert.deepEqual(journal.all(), before);
    assert.equal(new Orchestrator(journal).snapshot("p").tasks[0]!.status, "completed");
  } finally { finish?.(); await running; journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop close applies configured maintenance and reopening retains messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-maintenance-desktop-")), repo = join(root, "repo");
  mkdirSync(repo);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: repo, agents: [], tasks: [], journalMaintenance: policy }));
  const service = new DesktopService(join(root, "desktop"));
  try {
    service.openConfig(config);
    for (let i = 0; i < 100; i++) service.sendMessage({ to: "*", kind: "progress", body: String(i), idempotencyKey: String(i) });
    await service.close();
    const key = createHash("sha256").update(process.platform === "win32" ? repo.toLowerCase() : repo).digest("hex").slice(0, 16);
    const data = join(root, ".agentmesh-data", key);
    assert.equal(readdirSync(join(data, "archives")).filter(name => name.endsWith(".sqlite")).length, 1);
    const state = service.openConfig(config);
    assert.equal(state.historyCounts.messages, 100);
    assert.equal(service.messageHistory("p", repo).entries[0]!.message.body, "99");
    await service.close();
    assert.equal(readdirSync(join(data, "archives")).filter(name => name.endsWith(".sqlite")).length, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI dry-run leaves maintenance idle and empty execution rotates without invoking providers", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-maintenance-cli-")), repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ projectId: "p", repoPath: repo, agents: [], tasks: [], journalMaintenance: policy }));
  const key = createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 16);
  const path = join(root, ".agentmesh-data", key, "events.sqlite");
  const journal = new SqliteJournal(path);
  try {
    const engine = new Orchestrator(journal); engine.createProject({ id: "p", workspaceRoot: repo });
    for (let i = 0; i < 100; i++) engine.sendMessage("p", { to: "*", kind: "progress", body: String(i), idempotencyKey: String(i) });
  } finally { journal.close(); }
  try {
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--config", config, ...args], { encoding: "utf8", windowsHide: true }));
    assert.equal(cli().dryRun, true);
    assert.ok(!existsSync(join(dirname(path), "archives")));
    assert.equal(cli("--execute").maintenance.status, "compacted");
    assert.equal(readdirSync(join(dirname(path), "archives")).filter(name => name.endsWith(".sqlite")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
