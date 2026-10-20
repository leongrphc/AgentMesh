import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function fingerprintEvents(db: DatabaseSync) {
  const hash = createHash("sha256");
  let eventCount = 0, firstSequence: number | null = null, lastSequence: number | null = null;
  for (const row of db.prepare("SELECT sequence, id, at, project_id, payload FROM events ORDER BY sequence").iterate()) {
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Geçersiz arşiv olay sırası");
    firstSequence ??= sequence; lastSequence = sequence; eventCount++;
    hash.update(JSON.stringify([sequence, row.id, row.at, row.project_id, row.payload]) + "\n", "utf8");
  }
  return { eventCount, firstSequence, lastSequence, digest: hash.digest("hex") };
}

export function verifyJournalArchive(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (schema.user_version !== 2) throw new Error("Desteklenmeyen arşiv şeması");
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") throw new Error("Arşiv SQLite bütünlük kontrolü başarısız");
    const rows = db.prepare("SELECT manifest FROM archive_manifest").all();
    if (rows.length !== 1) throw new Error("Arşiv manifesti eksik veya tekrarlı");
    const manifest = JSON.parse(rows[0]!.manifest as string) as Record<string, unknown>;
    if (manifest.format !== 1 || manifest.algorithm !== "sha256-event-rows-v1" || typeof manifest.createdAt !== "string"
      || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("Geçersiz arşiv manifesti");
    const actual = fingerprintEvents(db);
    for (const key of ["eventCount", "firstSequence", "lastSequence", "digest"] as const) {
      if (manifest[key] !== actual[key]) throw new Error(`Arşiv doğrulaması başarısız: ${key}`);
    }
    return { format: 1, algorithm: "sha256-event-rows-v1", createdAt: manifest.createdAt, ...actual };
  } finally { db.close(); }
}
