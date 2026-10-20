import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { DomainEvent, StoredEvent, ContextConflict, MessageDelivery } from "./contracts.js";
import type { EventStore } from "./journal.js";
import { fingerprintEvents, verifyJournalArchive } from "./journal-archive.js";

/** Single-writer SQLite journal. A lock file prevents two orchestration processes writing concurrently. */
export class SqliteJournal implements EventStore {
  private readonly db: DatabaseSync;
  private readonly lockPath: string;
  private readonly lockFd: number;
  private closed = false;
  private archiveAlias?: "history0" | "history1";
  private activeScans = 0;

  constructor(path: string, legacyJsonl?: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.lockPath = `${path}.lock`;
    this.lockFd = this.acquireLock();
    let opened: DatabaseSync | undefined;
    try {
      this.db = opened = new DatabaseSync(path);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 3) throw new Error(`SQLite schema desteklenmiyor: ${version.user_version}`);
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
      // Derived indexes only: old writers maintain them automatically; event schema stays v2.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS journal_archive (id INTEGER PRIMARY KEY CHECK(id = 1), path TEXT NOT NULL, digest TEXT NOT NULL, through_sequence INTEGER NOT NULL, event_count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS replay_checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), format INTEGER NOT NULL, sequence INTEGER NOT NULL, source_id TEXT, state TEXT NOT NULL, digest TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS invalidate_checkpoint_update AFTER UPDATE ON events BEGIN DELETE FROM replay_checkpoint; END;
        CREATE TRIGGER IF NOT EXISTS invalidate_checkpoint_delete AFTER DELETE ON events BEGIN DELETE FROM replay_checkpoint; END;
        CREATE INDEX IF NOT EXISTS events_history_type ON events(project_id, json_extract(payload, '$.type'), sequence);
        CREATE INDEX IF NOT EXISTS events_type_project_sequence ON events(json_extract(payload, '$.type'), project_id, sequence);
        CREATE INDEX IF NOT EXISTS events_history_fact ON events(project_id, json_extract(payload, '$.type'), json_extract(payload, '$.fact.key'), sequence);
        CREATE INDEX IF NOT EXISTS events_history_task ON events(project_id, json_extract(payload, '$.type'), json_extract(payload, '$.taskId'), sequence);
        CREATE INDEX IF NOT EXISTS events_history_conflict ON events(project_id, json_extract(payload, '$.type'), json_extract(payload, '$.conflict.id'), sequence);
        CREATE INDEX IF NOT EXISTS events_delivery_task ON events(json_extract(payload, '$.delivery.taskId'), json_extract(payload, '$.delivery.messageId'), sequence) WHERE json_extract(payload, '$.type') = 'message.delivery';
        CREATE INDEX IF NOT EXISTS events_delivery_message ON events(json_extract(payload, '$.delivery.messageId'), sequence) WHERE json_extract(payload, '$.type') = 'message.delivery';
      `);
      const link = this.db.prepare("SELECT path, digest, through_sequence, event_count FROM journal_archive WHERE id = 1").get() as
        { path: string; digest: string; through_sequence: number; event_count: number } | undefined;
      if (version.user_version === 3 && !link) throw new Error("Arşiv bağlantısı eksik; journal açılamadı");
      if (link) {
        if (version.user_version !== 3) throw new Error("Arşiv bağlantısı ve journal şeması uyumsuz");
        const verified = verifyJournalArchive(link.path);
        if (verified.digest !== link.digest || verified.lastSequence !== link.through_sequence || verified.eventCount !== link.event_count) throw new Error("Bağlı arşiv doğrulanamadı");
        const overlap = this.db.prepare("SELECT 1 FROM main.events WHERE sequence <= ? LIMIT 1").get(link.through_sequence);
        if (overlap) throw new Error("Aktif journal ile arşiv sıraları çakışıyor");
        this.attachArchive(link.path, "history0");
        this.setHistoryView("history0"); this.archiveAlias = "history0";
      }
      if (legacyJsonl && existsSync(legacyJsonl) && !link) this.importJsonlOnce(legacyJsonl);
    } catch (error) {
      try { opened?.close(); } catch { /* Preserve the original open/migration error. */ }
      closeSync(this.lockFd);
      rmSync(this.lockPath, { force: true });
      throw error;
    }
  }

  all(): readonly StoredEvent[] {
    return [...this.scan()];
  }

  readEvent(id: string): StoredEvent | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT id, at, payload FROM events WHERE id = ?").get(id);
    return row ? { id: row.id as string, at: row.at as string, payload: JSON.parse(row.payload as string) as DomainEvent } : undefined;
  }

  readDelivery(taskId: string, messageId: string): MessageDelivery | undefined {
    this.assertOpen();
    const row = this.db.prepare(`SELECT payload FROM events WHERE json_extract(payload, '$.type') = 'message.delivery'
      AND json_extract(payload, '$.delivery.taskId') = ? AND json_extract(payload, '$.delivery.messageId') = ? ORDER BY sequence DESC LIMIT 1`).get(taskId, messageId);
    return row ? JSON.parse(row.payload as string).delivery : undefined;
  }

  *scanDeliveries(taskId?: string, messageId?: string): Iterable<MessageDelivery> {
    this.assertOpen();
    const filters = ["json_extract(payload, '$.type') = 'message.delivery'"];
    const params: string[] = [];
    if (taskId !== undefined) { filters.push("json_extract(payload, '$.delivery.taskId') = ?"); params.push(taskId); }
    if (messageId !== undefined) { filters.push("json_extract(payload, '$.delivery.messageId') = ?"); params.push(messageId); }
    const partition = "PARTITION BY json_extract(payload, '$.delivery.taskId'), json_extract(payload, '$.delivery.messageId')";
    const rows = this.db.prepare(`SELECT payload FROM (SELECT payload,
      ROW_NUMBER() OVER (${partition} ORDER BY sequence DESC) AS latest,
      MIN(sequence) OVER (${partition}) AS first_sequence FROM events WHERE ${filters.join(" AND ")})
      WHERE latest = 1 ORDER BY first_sequence`).iterate(...params);
    this.activeScans++;
    try { for (const row of rows) yield JSON.parse(row.payload as string).delivery as MessageDelivery; }
    finally { this.activeScans--; }
  }

  *scan(projectId?: string, afterSequence = 0): Iterable<StoredEvent> {
    this.assertOpen();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Geçersiz replay sınırı");
    const { last } = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM events").get() as { last: number };
    const rows = this.db.prepare(`SELECT id, at, payload FROM events WHERE sequence > ? AND sequence <= ?${projectId === undefined ? "" : " AND project_id = ?"} ORDER BY sequence`)
      .iterate(...(projectId === undefined ? [afterSequence, last] : [afterSequence, last, projectId]));
    this.activeScans++;
    try {
      for (const row of rows) yield { id: row.id as string, at: row.at as string, payload: JSON.parse(row.payload as string) as DomainEvent };
    } finally { this.activeScans--; }
  }

  scanAfter(sequence: number) { return this.scan(undefined, sequence); }

  loadCheckpoint() {
    this.assertOpen();
    try {
      const row = this.db.prepare("SELECT format, sequence, source_id, state, digest FROM replay_checkpoint WHERE id = 1").get() as
        { format: number; sequence: number; source_id: string | null; state: string; digest: string } | undefined;
      if (!row || row.format !== 1 || !Number.isSafeInteger(row.sequence) || row.sequence < 0) return undefined;
      const digest = createHash("sha256").update(JSON.stringify([row.format, row.sequence, row.source_id, row.state])).digest("hex");
      if (digest !== row.digest) return undefined;
      const boundary = this.db.prepare("SELECT id FROM events WHERE sequence = ?").get(row.sequence) as { id: string } | undefined;
      if (row.sequence === 0 ? row.source_id !== null : boundary?.id !== row.source_id) return undefined;
      return { sequence: row.sequence, sourceId: row.source_id, state: row.state };
    } catch { return undefined; } // Derived cache failures fall back to authoritative event replay.
  }

  saveCheckpoint(state: string, expectedSourceId: string | null) {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT sequence, id FROM events ORDER BY sequence DESC LIMIT 1").get() as { sequence: number; id: string } | undefined;
      if ((last?.id ?? null) !== expectedSourceId) throw new Error("Journal değişti; checkpoint için yeniden açın");
      const sequence = last?.sequence ?? 0;
      const digest = createHash("sha256").update(JSON.stringify([1, sequence, expectedSourceId, state])).digest("hex");
      this.db.prepare("INSERT OR REPLACE INTO replay_checkpoint(id, format, sequence, source_id, state, digest) VALUES (1, 1, ?, ?, ?, ?)").run(sequence, expectedSourceId, state, digest);
      this.db.exec("COMMIT");
      return { sequence, digest };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recent(projectId: string, limit = 200): StoredEvent[] {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Geçersiz son olay sınırı");
    const rows = this.db.prepare("SELECT id, at, payload FROM events WHERE project_id = ? ORDER BY sequence DESC LIMIT ?").all(projectId, limit);
    return rows.reverse().map(row => ({ id: row.id as string, at: row.at as string, payload: JSON.parse(row.payload as string) as DomainEvent }));
  }

  latestAgentSettings(projectId: string): StoredEvent[] {
    this.assertOpen();
    const row = this.db.prepare("SELECT id, at, payload FROM events WHERE project_id = ? AND json_extract(payload, '$.type') = 'project.agents.configured' ORDER BY sequence DESC LIMIT 1").get(projectId);
    return row ? [{ id: row.id as string, at: row.at as string, payload: JSON.parse(row.payload as string) as DomainEvent }] : [];
  }

  reservedTaskIds(projectId: string): string[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT json_extract(payload, '$.task.id') AS id FROM events WHERE json_extract(payload, '$.type') = 'task.created' AND project_id <> ?").all(projectId);
    return rows.map(row => row.id as string);
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

  archive(destination: string) {
    this.assertOpen();
    const path = resolve(destination);
    if (["", "-wal", "-shm", ".lock"].some(suffix => existsSync(path + suffix))) throw new Error("Arşiv hedefi zaten mevcut; yeni bir dosya adı kullanın");
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "wx", 0o600));
    let target: SqliteJournal | undefined;
    try {
      target = new SqliteJournal(path);
      const source = fingerprintEvents(this.db);
      target.db.exec("BEGIN IMMEDIATE");
      try {
        const insert = target.db.prepare("INSERT INTO events(sequence, id, at, project_id, payload) VALUES (?, ?, ?, ?, ?)");
        for (const row of this.db.prepare("SELECT sequence, id, at, project_id, payload FROM events ORDER BY sequence").iterate()) {
          insert.run(row.sequence!, row.id!, row.at!, row.project_id!, row.payload!);
        }
        const manifest = { format: 1, algorithm: "sha256-event-rows-v1", createdAt: new Date().toISOString(), ...source };
        target.db.exec("CREATE TABLE archive_manifest (id INTEGER PRIMARY KEY CHECK(id = 1), manifest TEXT NOT NULL)");
        target.db.prepare("INSERT INTO archive_manifest(id, manifest) VALUES (1, ?)").run(JSON.stringify(manifest));
        target.db.exec("COMMIT");
      } catch (error) { target.db.exec("ROLLBACK"); throw error; }
      target.close(); target = undefined;
      const verified = verifyJournalArchive(path);
      if (verified.digest !== source.digest) throw new Error("Arşiv kaynak journal ile eşleşmiyor");
      return { path, ...verified };
    } catch (error) {
      target?.close();
      rmSync(path, { force: true });
      throw error;
    }
  }

  /** Explicit lossless rotation: the verified archive becomes a required part of this journal. */
  compact(destination: string) {
    this.assertOpen();
    if (this.activeScans) throw new Error("Journal taraması bitmeden küçültme yapılamaz");
    const archive = this.archive(destination);
    if (archive.lastSequence === null) throw new Error("Boş journal küçültülemez; oluşturulan boş arşiv korunuyor");
    const next = this.archiveAlias === "history0" ? "history1" : "history0";
    const previous = this.archiveAlias;
    this.attachArchive(archive.path, next);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const checkpoint = this.db.prepare("SELECT * FROM replay_checkpoint WHERE id = 1").get();
        this.db.prepare("INSERT OR REPLACE INTO journal_archive(id, path, digest, through_sequence, event_count) VALUES (1, ?, ?, ?, ?)")
          .run(archive.path, archive.digest, archive.lastSequence, archive.eventCount);
        this.db.prepare("DELETE FROM main.events WHERE sequence <= ?").run(archive.lastSequence);
        if (checkpoint) this.db.prepare("INSERT OR REPLACE INTO replay_checkpoint(id, format, sequence, source_id, state, digest) VALUES (1, ?, ?, ?, ?, ?)")
          .run(checkpoint.format!, checkpoint.sequence!, checkpoint.source_id!, checkpoint.state!, checkpoint.digest!);
        this.db.exec("PRAGMA user_version=3");
        this.setHistoryView(next);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } catch (error) { this.db.exec(`DETACH DATABASE ${next}`); throw error; }
    this.archiveAlias = next;
    if (previous) this.db.exec(`DETACH DATABASE ${previous}`);
    let vacuumed = true;
    let maintenanceError: string | undefined;
    try {
      this.db.exec("DROP VIEW temp.events; VACUUM main;");
      const wal = this.db.prepare("PRAGMA main.wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (wal.busy) { vacuumed = false; maintenanceError = "Aktarım tamamlandı; WAL küçültme başka bir okuyucuyu bekliyor"; }
    }
    catch (error) { vacuumed = false; maintenanceError = String(error); } // Rotation is already committed; never misreport it as rolled back.
    finally { this.setHistoryView(next); }
    return { compacted: true, archive, vacuumed, ...(maintenanceError ? { maintenanceError } : {}) };
  }

  private attachArchive(path: string, alias: "history0" | "history1") {
    this.db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(pathToFileURL(resolve(path)).href + "?mode=ro");
  }

  private setHistoryView(alias: "history0" | "history1") {
    this.db.exec(`DROP VIEW IF EXISTS temp.events;
      CREATE TEMP VIEW events AS SELECT sequence, id, at, project_id, payload FROM ${alias}.events
      UNION ALL SELECT sequence, id, at, project_id, payload FROM main.events;`);
  }

  private insert(entry: StoredEvent): void {
    const projectId = entry.payload.type === "project.created"
      ? entry.payload.project.id
      : entry.payload.type === "task.created"
        ? entry.payload.task.projectId
        : entry.payload.projectId;
    this.db.prepare("INSERT INTO main.events(id, at, project_id, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
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
