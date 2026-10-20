export function validateContextKeys(keys: unknown): void {
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > 128 || new Set(keys).size !== keys.length
    || keys.some((key) => typeof key !== "string" || !key.trim() || key.length > 160))) throw new Error("Geçersiz context anahtar seçimi");
}

/** Shared validation for native envelopes and directly registered adapters. */
export function normalizeContextFacts(value: unknown): Array<{ key: string; value: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Ortak context en fazla 32 kayıt içerebilir");
  const keys = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Geçersiz ortak context kaydı");
    const fact = entry as Record<string, unknown>;
    if (typeof fact.key !== "string" || !fact.key.trim() || fact.key.length > 160 || /^(task\.|system\.)/.test(fact.key)
      || keys.has(fact.key) || typeof fact.value !== "string" || fact.value.length > 16384) throw new Error("Geçersiz veya tekrarlı ortak context kaydı");
    keys.add(fact.key);
    return { key: fact.key, value: fact.value };
  });
}
