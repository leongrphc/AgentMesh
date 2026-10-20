import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
      { maxActiveAgeHours: 87601 }, { maxActiveEvents: undefined }, { ...policy, deleteHistory: true }]) {
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
