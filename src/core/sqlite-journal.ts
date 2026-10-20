import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DomainEvent, StoredEvent, ContextConflict } from "./contracts.js";
import type { EventStore } from "./journal.js";

/** Single-writer SQLite journal. A lock file prevents two orchestration processes writing concurrently. */
export class SqliteJournal implements EventStore {
  private readonly db: DatabaseSync;
  private readonly lockPath: string;
  private readonly lockFd: number;
  private closed = false;

  constructor(path: string, legacyJsonl?: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.lockPath = `${path}.lock`;
    this.lockFd = this.acquireLock();
    let opened: DatabaseSync | undefined;
    try {
      this.db = opened = new DatabaseSync(path);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 2) throw new Error(`SQLite schema desteklenmiyor: ${version.user_version}`);
      if (version.user_version < 1) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            at TEXT NOT NULL,
            project_id TEXT NOT NULL,
            payload TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS events_project_sequence ON events(project_id, sequence);
          PRAGMA user_version=2;
          COMMIT;`);
      }
      // v2 adds decision/conflict event semantics. Old binaries must not ignore pending decisions.
      if (version.user_version === 1) this.db.exec("BEGIN IMMEDIATE; PRAGMA user_version=2; COMMIT;");
      if (legacyJsonl && existsSync(legacyJsonl)) this.importJsonlOnce(legacyJsonl);
      // Derived indexes only: old writers maintain them automatically; event schema stays v2.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS events_history_type ON events(project_id, json_extract(payload, '$.type'), sequence);
        CREATE INDEX IF NOT EXISTS events_history_fact ON events(project_id, json_extract(payload, '$.type'), json_extract(payload, '$.fact.key'), sequence);
        CREATE INDEX IF NOT EXISTS events_history_task ON events(project_id, json_extract(payload, '$.type'), json_extract(payload, '$.taskId'), sequence);
        CREATE INDEX IF NOT EXISTS events_history_conflict ON events(project_id, json_extract(payload, '$.type'), json_extract(payload, '$.conflict.id'), sequence);
      `);
    } catch (error) {
      try { opened?.close(); } catch { /* Preserve the original open/migration error. */ }
      closeSync(this.lockFd);
      rmSync(this.lockPath, { force: true });
      throw error;
    }
  }

  all(): readonly StoredEvent[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT id, at, payload FROM events ORDER BY sequence").all() as
      Array<{ id: string; at: string; payload: string }>;
    return rows.map((row) => ({ id: row.id, at: row.at, payload: JSON.parse(row.payload) as DomainEvent }));
  }

  contextHistoryPage(projectId: string, key: string, before?: number) {
    const page = this.historyEvents(projectId, "context.updated", "fact.key", key, before);
    return { entries: page.rows.map((row, index) => {
      const event = JSON.parse(row.payload) as Extract<DomainEvent, { type: "context.updated" }>;
      return { ...event.fact, revision: page.end - index };
    }), latestRevision: page.total, ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}) };
  }

  contextPackagesPage(projectId: string, taskId: string, before?: number) {
    const page = this.historyEvents(projectId, "task.context.prepared", "taskId", taskId, before);
    return { entries: page.rows.map(row => (JSON.parse(row.payload) as Extract<DomainEvent, { type: "task.context.prepared" }>).package),
      total: page.total, ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}) };
  }

  resolvedContextPage(projectId: string, before?: number) {
    const page = this.historyEvents(projectId, "context.conflict.resolved", undefined, undefined, before);
    const entries = page.rows.map(row => {
      const event = JSON.parse(row.payload) as Extract<DomainEvent, { type: "context.conflict.resolved" }>;
      const proposal = this.db.prepare(`SELECT payload FROM events WHERE project_id = ?
        AND json_extract(payload, '$.type') = 'context.conflict.created'
        AND json_extract(payload, '$.conflict.id') = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1`).get(projectId, event.conflictId, row.sequence) as { payload: string } | undefined;
      if (!proposal) throw new Error("Context çözümünün kaynak önerisi bulunamadı");
      const created = JSON.parse(proposal.payload) as Extract<DomainEvent, { type: "context.conflict.created" }>;
      return { ...created.conflict, status: "resolved", resolution: { choice: event.choice, revision: event.revision, at: event.at } } satisfies ContextConflict;
    });
    return { entries, total: page.total, ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}) };
  }

  private historyEvents(projectId: string, type: string, field: "fact.key" | "taskId" | undefined, value: string | undefined, before?: number) {
    this.assertOpen();
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error("Geçersiz geçmiş sayfası");
    // Only the closed field union enters SQL; all caller values are bound parameters.
    const where = `project_id = ? AND json_extract(payload, '$.type') = ?${field ? ` AND json_extract(payload, '$.${field}') = ?` : ""}`;
    const params = field ? [projectId, type, value!] : [projectId, type];
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM events WHERE ${where}`).get(...params) as { total: number };
    const end = Math.min(total, (before ?? total + 1) - 1);
    const size = Math.min(20, end);
    const rows = this.db.prepare(`SELECT sequence, payload FROM events WHERE ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`)
      .all(...params, size, total - end) as Array<{ sequence: number; payload: string }>;
    return { rows, total, end, nextBefore: end > size ? end - size + 1 : undefined };
  }

  append(payload: DomainEvent): StoredEvent {
    return this.appendBatch([payload])[0]!;
  }

  appendBatch(payloads: readonly DomainEvent[]): readonly StoredEvent[] {
    this.assertOpen();
    const entries: StoredEvent[] = payloads.map((payload) => ({
      id: randomUUID(), at: new Date().toISOString(), payload,
    }));
    if (!entries.length) return entries;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) this.insert(entry);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return entries;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); }
    finally {
      closeSync(this.lockFd);
      rmSync(this.lockPath, { force: true });
    }
  }

  private insert(entry: StoredEvent): void {
    const projectId = entry.payload.type === "project.created"
      ? entry.payload.project.id
      : entry.payload.type === "task.created"
        ? entry.payload.task.projectId
        : entry.payload.projectId;
    this.db.prepare("INSERT INTO events(id, at, project_id, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(entry.id, entry.at, projectId, JSON.stringify(entry.payload));
  }

  private importJsonlOnce(path: string): void {
    const count = this.db.prepare("SELECT COUNT(*) AS total FROM events").get() as { total: number };
    if (count.total !== 0) return;
    const entries = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) this.insert(entry);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
        return fd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let pid: number | undefined;
        try { pid = (JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: number }).pid; }
        catch { /* broken lock is handled explicitly */ }
        if (!pid || !Number.isInteger(pid) || pid < 1) throw new Error(`SQLite kilidi incelenmeli: ${this.lockPath}`);
        try {
          process.kill(pid, 0);
          throw new Error(`SQLite başka bir işlem tarafından kullanılıyor (PID ${pid}): ${this.lockPath}`);
        } catch (processError) {
          if ((processError as NodeJS.ErrnoException).code !== "ESRCH") throw processError;
          rmSync(this.lockPath, { force: true });
        }
      }
    }
    throw new Error(`SQLite kilidi alınamadı: ${this.lockPath}`);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite journal kapalı");
  }
}
