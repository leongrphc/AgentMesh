import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DomainEvent, StoredEvent, ContextHistoryPage, HistoryPage, ContextConflict, ContextPackage } from "./contracts.js";

export interface EventStore {
  readEvent?(id: string): StoredEvent | undefined;
  loadCheckpoint?(): { sequence: number; sourceId: string | null; state: string } | undefined;
  saveCheckpoint?(state: string, expectedSourceId: string | null): { sequence: number; digest: string };
  scanAfter?(sequence: number): Iterable<StoredEvent>;
  scan?(projectId?: string): Iterable<StoredEvent>;
  contextHistoryPage?(projectId: string, key: string, before?: number): ContextHistoryPage;
  resolvedContextPage?(projectId: string, before?: number): HistoryPage<ContextConflict>;
  contextPackagesPage?(projectId: string, taskId: string, before?: number): HistoryPage<ContextPackage>;
  all(): readonly StoredEvent[];
  append(payload: DomainEvent): StoredEvent;
  appendBatch(payloads: readonly DomainEvent[]): readonly StoredEvent[];
}

export function* eventStream(store: EventStore, projectId?: string): Iterable<StoredEvent> {
  if (store.scan) { yield* store.scan(projectId); return; }
  for (const event of store.all()) {
    const payload = event.payload;
    const id = payload.type === "project.created" ? payload.project.id : payload.type === "task.created" ? payload.task.projectId : payload.projectId;
    if (projectId === undefined || id === projectId) yield event;
  }
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
