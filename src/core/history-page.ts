import type { HistoryPage } from "./contracts.js";

/** Append-only ordinals keep older pages stable while new records arrive. */
export function historyPage<T>(entries: readonly T[], before?: number): HistoryPage<T> {
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error("Geçersiz geçmiş sayfası");
  const end = Math.min(entries.length, (before ?? entries.length + 1) - 1);
  const start = Math.max(0, end - 20);
  return { entries: structuredClone(entries.slice(start, end).reverse()), total: entries.length,
    ...(start > 0 ? { nextBefore: start + 1 } : {}) };
}
