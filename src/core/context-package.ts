import { createHash } from "node:crypto";
import type { AgentTask, ContextPackage, Fact } from "./contracts.js";

import { validateContextKeys } from "./context.js";

/** Project decisions plus summaries from the dependency closure; no silent truncation. */
export function prepareContext(task: AgentTask, tasks: readonly AgentTask[], facts: Readonly<Record<string, Fact>>, executionId: string) {
  validateContextKeys(task.contextKeys);
  const byId = new Map(tasks.filter((entry) => entry.projectId === task.projectId).map((entry) => [entry.id, entry]));
  const ancestors = new Set<string>();
  const queue = [...task.dependsOn];
  while (queue.length) {
    const id = queue.pop()!;
    if (ancestors.has(id)) continue;
    const dependency = byId.get(id);
    if (!dependency) throw new Error("Context bağımlılığı aynı projede bulunamadı");
    ancestors.add(id); queue.push(...dependency.dependsOn);
  }
  const summaries = new Set([...ancestors].map((id) => `task.${id}.summary`));
  const explicit = task.contextKeys === undefined ? undefined : new Set(task.contextKeys);
  if (task.contextKeys?.some((key) => !Object.hasOwn(facts, key))) throw new Error("Seçilen context anahtarı bulunamadı; üretici görevi bağımlılıklara ekleyin veya seçimi düzeltin");
  const selected = Object.values(facts).filter((fact) => summaries.has(fact.key) || (explicit ? explicit.has(fact.key) : !fact.key.startsWith("task.")))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (selected.length > 128) throw new Error("Context paketi 128 kayıt sınırını aşıyor; görev context kapsamını daraltın");
  if (selected.some((fact) => !Number.isInteger(fact.revision) || fact.revision! < 1)) throw new Error("Context sürüm bilgisi eksik");
  const context: Record<string, Fact> = structuredClone(Object.fromEntries(selected.map((fact) => [fact.key, fact])));
  const serialized = JSON.stringify(context);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > 256 * 1024) throw new Error("Context paketi 256 KiB sınırını aşıyor; görev context kapsamını daraltın");
  const metadata: ContextPackage = { policyVersion: 1, executionId, bytes,
    digest: createHash("sha256").update(serialized).digest("hex"),
    entries: selected.map((fact) => ({ key: fact.key, revision: fact.revision! })),
  };
  return { context, metadata };
}
