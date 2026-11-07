import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { AgentConfig, Config } from "../core/config.js";
import type { CodexProfile } from "../adapters/codex-profiles.js";

/**
 * Agents a freshly opened folder starts with; users can add more from the agent center.
 * Folder projects that were opened before keep the agent list stored in their journal
 * (see DesktopService.openFolder), so this default only affects new projects.
 */
export const DEFAULT_FOLDER_AGENTS: AgentConfig[] = [
  { id: "claude", provider: "claude" },
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

/** Above this many files a first commit is refused: the folder is almost certainly not one project. */
const MAX_INITIAL_FILES = 20_000;

/**
 * Kept out of the first commit when AgentMesh creates the repository: dependency and build output
 * (large, regenerable) and environment files (often secrets). Written to .git/info/exclude so the
 * user's own .gitignore is never created or changed.
 */
const INITIAL_EXCLUDES = [
  "node_modules/", ".venv/", "venv/", "__pycache__/", ".pytest_cache/", "dist/", "build/", "out/", ".next/", ".nuxt/",
  "target/", "bin/Debug/", "bin/Release/", "obj/", ".gradle/", ".idea/", ".vs/", "*.log",
  ".env", ".env.*", "!.env.example", ".DS_Store", "Thumbs.db",
];

/** Folders that are never turned into a repository: a drive root, the home folder itself, Windows. */
export function unsafeRepositoryRoot(folder: string): string | undefined {
  const path = realpathSync(folder);
  const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  if (same(path, parse(path).root)) return "bir sürücünün kökü";
  if (same(path, homedir())) return "kullanıcı klasörünüzün tamamı";
  const windows = process.env.SystemRoot ?? process.env.windir;
  if (windows && (same(path, windows) || path.toLowerCase().startsWith(resolve(windows).toLowerCase() + sep))) return "bir Windows sistem klasörü";
  return undefined;
}

function gitAvailable(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true }); return true; }
  catch { return false; }
}

/** Commits everything that is not excluded, with a fallback identity when Git has none configured. */
function initialCommit(root: string): number {
  const pending = git(root, "ls-files", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean).length;
  if (pending > MAX_INITIAL_FILES) {
    throw new Error(`Klasörde ${pending.toLocaleString("tr-TR")} dosya var; bu tek bir proje gibi görünmüyor. `
      + "Proje klasörünü seçin ya da büyük klasörleri .gitignore ile dışarıda bırakıp tekrar açın.");
  }
  let identity: string[] = [];
  try { git(root, "config", "user.email"); } catch { identity = ["-c", "user.name=AgentMesh", "-c", "user.email=agentmesh@localhost"]; }
  git(root, "add", "-A");
  git(root, ...identity, "commit", "-q", "--allow-empty", "-m", "AgentMesh: başlangıç durumu");
  return pending;
}

/**
 * Makes any project folder usable: when it is not a Git repository yet, one is created and the
 * current files become the first commit (agents start from the last commit); a repository without
 * commits gets that first commit too. Returns the repository root and, when something was created,
 * a sentence telling the user what happened.
 */
export function prepareRepository(folder: string): { root: string; notice?: string } {
  if (!existsSync(folder)) throw new Error(`Klasör bulunamadı: ${folder}`);
  if (!gitAvailable()) throw new Error("Git bulunamadı. AgentMesh görevleri Git ile ayırır; Git'i kurun (https://git-scm.com) ve uygulamayı yeniden başlatın.");
  let root: string | undefined;
  try { root = git(folder, "rev-parse", "--show-toplevel"); } catch { root = undefined; }
  let notice: string | undefined;
  if (!root) {
    const unsafe = unsafeRepositoryRoot(folder);
    if (unsafe) throw new Error(`Seçilen klasör ${unsafe}. Lütfen tek bir projenin klasörünü seçin.`);
    git(folder, "init", "-q");
    root = git(folder, "rev-parse", "--show-toplevel");
    const exclude = git(root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `\n# AgentMesh: ilk commit'e alınmayanlar\n${INITIAL_EXCLUDES.join("\n")}\n`);
    try {
      const files = initialCommit(root);
      notice = `Bu klasör Git deposu değildi. AgentMesh bir depo başlattı ve ${files.toLocaleString("tr-TR")} dosyayı ilk commit olarak kaydetti; `
        + "node_modules, build çıktıları ve .env dosyaları dahil edilmedi.";
    } catch (error) {
      // Leave the folder exactly as it was if the first commit could not be made.
      rmSync(join(root, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    }
  } else {
    try { git(root, "rev-parse", "--verify", "HEAD"); }
    catch {
      const files = initialCommit(root);
      notice = `Depoda hiç commit yoktu. AgentMesh mevcut ${files.toLocaleString("tr-TR")} dosyayı ilk commit olarak kaydetti.`;
    }
  }
  return { root: resolveRepository(root), notice };
}

/** True when the repository has uncommitted changes that agents will not see. */
export function hasUncommittedChanges(root: string): boolean {
  try { return git(root, "status", "--porcelain", "--untracked-files=normal").length > 0; }
  catch { return false; }
}

export function repositoryKey(root: string): string {
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 16);
}

/**
 * New folder project config. When separate Codex accounts exist (~/.codex-profiles), the Codex
 * agent starts on the first one instead of the default ~/.codex home; it can be changed later.
 */
export function folderConfig(root: string, codexProfiles: readonly CodexProfile[] = []): Config {
  const slug = basename(root).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "proje";
  return {
    projectId: `${slug}-${repositoryKey(root).slice(0, 6)}`,
    repoPath: root,
    maxParallel: 2,
    agents: DEFAULT_FOLDER_AGENTS.map((agent) => agent.provider === "codex" && codexProfiles[0]
      ? { ...agent, codexHome: codexProfiles[0].path } : { ...agent }),
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
