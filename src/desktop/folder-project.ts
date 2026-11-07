import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentConfig, Config } from "../core/config.js";

/**
 * Agents a freshly opened folder starts with. Users can add more from the agent center.
 * The journal stores this list as the project's source agents, so changing it makes existing
 * folder projects fail to reopen; treat it as a stable default.
 */
export const DEFAULT_FOLDER_AGENTS: AgentConfig[] = [
  { id: "codex", provider: "codex", transport: "app-server" },
];

/** Default file scope for tasks created in a folder project: every non-hidden path. */
export const DEFAULT_ALLOWED_PATHS = ["**"];

const MAX_RECENT = 8;

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Resolves a user-selected folder to its Git repository root.
 * Worktree isolation needs a repository with at least one commit, so both are checked up front
 * with an actionable message instead of failing later inside the scheduler.
 */
export function resolveRepository(folder: string): string {
  if (!existsSync(folder)) throw new Error(`Klasör bulunamadı: ${folder}`);
  let root: string;
  try { root = git(folder, "rev-parse", "--show-toplevel"); }
  catch {
    throw new Error("Bu klasör bir Git deposu değil. Ajanlar her görevi ayrı bir Git worktree'sinde çalıştırır. "
      + "Klasörde şunları çalıştırıp tekrar açın: git init, git add -A, git commit -m \"ilk\"");
  }
  try { git(root, "rev-parse", "--verify", "HEAD"); }
  catch {
    throw new Error("Depoda henüz commit yok. Ajanlar son commit'ten çalışır. "
      + "Önce bir commit oluşturun: git add -A, git commit -m \"ilk\"");
  }
  return realpathSync(root);
}

/** True when the repository has uncommitted changes that agents will not see. */
export function hasUncommittedChanges(root: string): boolean {
  try { return git(root, "status", "--porcelain", "--untracked-files=normal").length > 0; }
  catch { return false; }
}

export function repositoryKey(root: string): string {
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 16);
}

export function folderConfig(root: string): Config {
  const slug = basename(root).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "proje";
  return {
    projectId: `${slug}-${repositoryKey(root).slice(0, 6)}`,
    repoPath: root,
    maxParallel: 2,
    agents: structuredClone(DEFAULT_FOLDER_AGENTS),
    tasks: [],
  };
}

function recentFile(dataRoot: string) {
  return join(dataRoot, "recent-projects.json");
}

export function readRecent(dataRoot: string): RecentProject[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recentFile(dataRoot), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentProject => !!item && typeof item.path === "string"
      && typeof item.name === "string" && typeof item.openedAt === "string").slice(0, MAX_RECENT);
  } catch { return []; }
}

export function rememberRecent(dataRoot: string, root: string): RecentProject[] {
  const same = (path: string) => process.platform === "win32" ? path.toLowerCase() === root.toLowerCase() : path === root;
  const next = [{ path: root, name: basename(root), openedAt: new Date().toISOString() },
    ...readRecent(dataRoot).filter((item) => !same(item.path))].slice(0, MAX_RECENT);
  mkdirSync(dataRoot, { recursive: true });
  const file = recentFile(dataRoot);
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), "utf8");
  renameSync(`${file}.tmp`, file);
  return next;
}
