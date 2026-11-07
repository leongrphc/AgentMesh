import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface CodexProfile {
  name: string;
  /** Absolute CODEX_HOME directory of this profile. */
  path: string;
}

/** Codex's default home when CODEX_HOME is not set. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * Separate Codex accounts are commonly kept as separate CODEX_HOME folders
 * (for example ~/.codex-profiles/codex1 used by a shell wrapper). A folder counts as a
 * profile when it holds Codex credentials or configuration.
 */
export function listCodexProfiles(root = join(homedir(), ".codex-profiles")): CodexProfile[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names
    .map((name) => ({ name, path: join(root, name) }))
    .filter(({ path }) => {
      try { return statSync(path).isDirectory() && (existsSync(join(path, "auth.json")) || existsSync(join(path, "config.toml"))); }
      catch { return false; }
    })
    .sort((a, b) => a.name.localeCompare(b.name, "tr", { numeric: true }));
}

/** Syntax check only; existence is checked when the agent actually starts. */
export function validCodexHome(value: unknown): value is string {
  return typeof value === "string" && value.length <= 500 && isAbsolute(value) && !/[\0\r\n]/.test(value);
}

/** Environment for a Codex child process bound to one profile, or the inherited one without a profile. */
export function codexEnv(codexHome?: string): NodeJS.ProcessEnv | undefined {
  if (!codexHome) return undefined;
  if (!existsSync(codexHome)) throw new Error(`Codex profil klasörü bulunamadı: ${codexHome}`);
  return { ...process.env, CODEX_HOME: codexHome };
}
