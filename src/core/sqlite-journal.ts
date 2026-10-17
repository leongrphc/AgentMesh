import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DomainEvent, StoredEvent } from "./contracts.js";
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
    try {
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 1) throw new Error(`SQLite schema desteklenmiyor: ${version.user_version}`);
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
          PRAGMA user_version=1;
          COMMIT;`);
      }
      if (legacyJsonl && existsSync(legacyJsonl)) this.importJsonlOnce(legacyJsonl);
    } catch (error) {
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
    this.db.prepare("INSERT OR IGNORE INTO events(id, at, project_id, payload) VALUES (?, ?, ?, ?)")
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
