import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTMESH_DIR, excludeAgentmeshDir } from "./worktrees.js";

/**
 * Journal of a config-file project, shared by the desktop app and the CLI.
 *
 * New projects keep it inside the repository (.agentmesh/data/events.sqlite, hidden from Git).
 * Earlier versions wrote it next to the repository (../.agentmesh-data/<key>/); when such a
 * journal exists it is used as-is so no history is lost or silently duplicated.
 */
export function configJournalPath(repoPath: string): string {
  // The desktop app hashed the exact path off Windows while the CLI always lowercased it; honour both.
  const legacy = [repoPath.toLowerCase(), repoPath]
    .map((value) => join(dirname(repoPath), ".agentmesh-data", createHash("sha256").update(value).digest("hex").slice(0, 16), "events.sqlite"))
    .find((path) => existsSync(path));
  if (legacy) return legacy;
  try { excludeAgentmeshDir(repoPath); } catch { /* Not a Git repository yet; nothing to hide from. */ }
  return join(repoPath, AGENTMESH_DIR, "data", "events.sqlite");
}
