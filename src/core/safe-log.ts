/** Best-effort diagnostic filtering; arbitrary personal data cannot be recognized reliably. */
export function safeLog(text: string, policy: "display" | "storage" = "display"): string {
  const cleaned = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED KEY]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]");
  const limit = policy === "storage" ? 2048 : 8192;
  return cleaned.length > limit ? cleaned.slice(0, limit) + " [TRUNCATED]" : cleaned;
}
