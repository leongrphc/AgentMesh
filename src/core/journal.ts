import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DomainEvent, StoredEvent } from "./contracts.js";

export interface EventStore {
  all(): readonly StoredEvent[];
  append(payload: DomainEvent): StoredEvent;
  appendBatch(payloads: readonly DomainEvent[]): readonly StoredEvent[];
}

/** MVP: tek proses tarafından yazılan, disk üzerinde kalıcı JSONL olay günlüğü. */
export class Journal implements EventStore {
  private readonly entries: StoredEvent[];

  constructor(private readonly path: string) {
    const lines = existsSync(path)
      ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    this.entries = lines.map((line) => JSON.parse(line) as StoredEvent);
  }

  all(): readonly StoredEvent[] {
    return this.entries;
  }

  append(payload: DomainEvent): StoredEvent {
    return this.appendBatch([payload])[0]!;
  }

  appendBatch(payloads: readonly DomainEvent[]): readonly StoredEvent[] {
    const entries: StoredEvent[] = payloads.map((payload) => ({
      id: randomUUID(), at: new Date().toISOString(), payload,
    }));
    mkdirSync(dirname(this.path), { recursive: true });
    if (entries.length) appendFileSync(this.path, entries.map((entry) => JSON.stringify(entry) + "\n").join(""), "utf8");
    this.entries.push(...entries);
    return entries;
  }
}
