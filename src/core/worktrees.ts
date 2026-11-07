import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, resolve, sep } from "node:path";

export interface WorktreeLease {
  path: string;
  branch: string;
  baseCommit?: string;
}

export interface MergeConflict {
  paths: string[];
  integrationCommit: string;
  taskCommit: string;
}

export class MergeConflictError extends Error {
  constructor(readonly conflict: MergeConflict) {
    super(`Entegrasyon conflict, görev branch'i korundu: ${conflict.paths.join(", ")}`);
  }
}

export interface WorktreeInspection {
  digest: string;
  changedPaths: string[];
  violations: string[];
  trackedDiff: string;
  untrackedPreviews: Array<{ path: string; preview: string; truncated: boolean; binary: boolean }>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
}

function exactRoot(path: string): string {
  const root = git(path, "rev-parse", "--show-toplevel").trim();
  if (resolve(root).toLowerCase() !== resolve(path).toLowerCase()) {
    throw new Error(`Depo kökü kullanılmalı: ${root}`);
  }
  return realpathSync(path);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Folder inside the repository that holds everything AgentMesh writes for it. */
export const AGENTMESH_DIR = ".agentmesh";

/** Task and integration worktrees live inside the repository, under .agentmesh/worktrees. */
export function worktreesRoot(root: string): string {
  return join(root, AGENTMESH_DIR, "worktrees");
}

/** Worktrees created by versions that wrote next to the repository; still honoured when reopening. */
function legacyWorktreesRoot(root: string): string {
  return join(dirname(root), ".agentmesh-worktrees", shortHash(root.toLowerCase()));
}

/**
 * Hides .agentmesh/ from Git through the repository-local exclude file, so it never shows up as an
 * untracked change and never blocks the clean-repository check. The user's .gitignore is untouched.
 */
export function excludeAgentmeshDir(repoPath: string): void {
  const exclude = git(repoPath, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  const entry = `/${AGENTMESH_DIR}/`;
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(exclude, `${separator}# AgentMesh görev çalışma alanları\n${entry}\n`);
}

function mergeInProgress(worktree: string): boolean {
  try { git(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"); return true; }
  catch { return false; }
}

/** Path of an existing worktree that has `branch` checked out, if any. */
function checkedOutAt(root: string, branch: string): string | undefined {
  let path: string | undefined;
  for (const line of git(root, "worktree", "list", "--porcelain").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path && existsSync(path)) return path;
  }
  return undefined;
}

/** Branch where approved task changes accumulate; the user's own branches are never modified. */
export function integrationBranch(repoPath: string): string {
  return `agentmesh/integration-${shortHash(exactRoot(repoPath).toLowerCase()).slice(0, 8)}`;
}

/** Ayrı branch/worktree üretir. Repoya otomatik merge veya force-delete yapmaz. */
export class WorktreeManager {
  integration(repoPath: string): WorktreeLease {
    const root = exactRoot(repoPath);
    const branch = integrationBranch(root);
    excludeAgentmeshDir(root);
    const path = join(worktreesRoot(root), "integration");
    const existing = checkedOutAt(root, branch);
    if (existing && resolve(existing).toLowerCase() !== resolve(path).toLowerCase()) {
      // Earlier versions kept it next to the repository. Move it inside when it is clean; an
      // in-progress merge resolution stays where it is so nothing half-done is disturbed.
      const clean = !git(existing, "status", "--porcelain", "--untracked-files=normal").trim() && !mergeInProgress(existing);
      if (!clean || existsSync(path)) return this.reopen(root, { path: existing, branch });
      mkdirSync(dirname(path), { recursive: true });
      git(root, "worktree", "move", existing, path);
      return this.reopen(root, { path, branch });
    }
    if (existing) return this.reopen(root, { path: existing, branch });
    if (existsSync(path)) return this.reopen(root, { path, branch });
    if (git(root, "status", "--porcelain", "--untracked-files=normal").trim()) {
      throw new Error("Entegrasyon alanını başlatmak için ana depo temiz olmalı");
    }
    git(root, "rev-parse", "--verify", "HEAD");
    // Mevcut branch varsa (ör. önceki bir çalışma), onu kaldığı yerden bağla.
    const branchExists = git(root, "branch", "--list", branch).trim().length > 0;
    if (branchExists) git(root, "worktree", "add", path, branch);
    else git(root, "worktree", "add", "-b", branch, path, "HEAD");
    return { path, branch };
  }

  /**
   * Undoes what a test run wrote into a task worktree (coverage, snapshots, build output) without
   * touching the agent's own changes, listed in `keep`. Ignored files (installed dependencies) stay.
   */
  discardTestArtifacts(worktreePath: string, keep: readonly string[]): string[] {
    const keepSet = new Set(keep.map((path) => path.replace(/\\/g, "/")));
    const entries = git(worktreePath, "status", "--porcelain", "-z", "--untracked-files=all").split("\0").filter(Boolean);
    const discarded: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const code = entries[i]!.slice(0, 2);
      const path = entries[i]!.slice(3);
      if (code[0] === "R" || code[0] === "C") i++; // Rename/copy records carry the old path next.
      if (keepSet.has(path)) continue;
      if (code === "??") rmSync(join(worktreePath, path), { force: true, recursive: true });
      else git(worktreePath, "checkout", "HEAD", "--", path);
      discarded.push(path);
    }
    return discarded;
  }

  /**
   * Both sides of one changed file for a side-by-side review: the version at the task's review base
   * and the one in its worktree. A side is null when the file did not exist there. Files that are
   * binary or larger than 1 MiB are reported as such instead of being returned.
   */
  fileVersions(repoPath: string, lease: WorktreeLease, path: string): { original: string | null; modified: string | null; skipped?: "binary" | "large" } {
    const verified = this.reopen(repoPath, lease);
    const normalized = path.replace(/\\/g, "/");
    const full = resolve(verified.path, normalized);
    if (isAbsolute(normalized) || normalized.split("/").includes("..") || !full.toLowerCase().startsWith((resolve(verified.path) + sep).toLowerCase())) {
      throw new Error("Geçersiz dosya yolu");
    }
    const limit = 1024 * 1024;
    const base = this.reviewBase(repoPath, verified);
    let original: string | null = null;
    try {
      const size = Number(git(verified.path, "cat-file", "-s", `${base}:${normalized}`).trim());
      if (size > limit) return { original: null, modified: null, skipped: "large" };
      original = git(verified.path, "show", `${base}:${normalized}`);
    } catch { original = null; }
    let modified: string | null = null;
    if (existsSync(full) && !lstatSync(full).isSymbolicLink() && lstatSync(full).isFile()) {
      if (lstatSync(full).size > limit) return { original: null, modified: null, skipped: "large" };
      modified = readFileSync(full, "utf8");
    }
    if ([original, modified].some((text) => text !== null && text.includes("\0"))) return { original: null, modified: null, skipped: "binary" };
    return { original, modified };
  }

  /** True when `commit` is already contained in the repository's checked-out branch. */
  isApplied(repoPath: string, commit: string): boolean {
    try { git(exactRoot(repoPath), "merge-base", "--is-ancestor", commit, "HEAD"); return true; }
    catch { return false; }
  }

  /**
   * Deletes a finished task's worktree and its branch. Only ever called for tasks whose work is
   * already in the user's branch (or that changed nothing), so no work can be lost.
   */
  removeTaskWorktree(repoPath: string, lease: WorktreeLease): void {
    const root = exactRoot(repoPath);
    const verified = this.reopen(root, lease);
    if (verified.branch === integrationBranch(root)) throw new Error("Entegrasyon çalışma alanı silinemez");
    git(root, "worktree", "remove", "--force", verified.path);
    try { git(root, "branch", "-D", verified.branch); } catch { /* The branch may already be gone; the worktree is what takes space. */ }
  }

  /** Number of approved commits on the integration branch that the checked-out branch does not have yet. */
  pendingIntegration(repoPath: string): number {
    const root = exactRoot(repoPath);
    const branch = integrationBranch(root);
    if (!git(root, "branch", "--list", branch).trim()) return 0;
    return Number(git(root, "rev-list", "--count", `HEAD..${branch}`).trim()) || 0;
  }

  /**
   * Brings approved work into the user's checked-out branch, i.e. into the selected folder itself.
   * Requires a clean working tree on a named branch; prefers a fast-forward, otherwise creates a
   * merge commit, and aborts the merge on conflicts so the repository is never left half-merged.
   */
  applyIntegration(repoPath: string): { branch: string; commits: number; fastForward: boolean } {
    const root = exactRoot(repoPath);
    const integration = integrationBranch(root);
    const commits = this.pendingIntegration(root);
    if (!commits) throw new Error("Projenize uygulanacak yeni onaylı değişiklik yok.");
    const branch = git(root, "branch", "--show-current").trim();
    if (!branch) throw new Error("Depo bir dalda değil (ayrık HEAD). Önce kendi dalınıza geçin.");
    if (git(root, "status", "--porcelain", "--untracked-files=normal").trim()) {
      throw new Error("Projede commit edilmemiş değişiklik var. Önce commit edin veya geri alın; değişikliklerinizin üzerine yazılmaz.");
    }
    try {
      git(root, "merge", "--ff-only", integration);
      return { branch, commits, fastForward: true };
    } catch { /* Branch moved on since the tasks started: fall back to a real merge. */ }
    try {
      git(root, "merge", "--no-edit", "-m", `AgentMesh: onaylı görevleri birleştir (${integration})`, integration);
      return { branch, commits, fastForward: false };
    } catch (error) {
      try { git(root, "merge", "--abort"); } catch { /* Nothing to abort when the merge never started. */ }
      const conflicted = String((error as { stdout?: string }).stdout ?? "").includes("CONFLICT");
      throw new Error(conflicted
        ? `Kendi dalınızla çakışma çıktı; birleştirme geri alındı, projeniz değişmedi. Elle birleştirmek için: git merge ${integration}`
        : `Birleştirme yapılamadı; projeniz değişmedi. Ayrıntı için: git merge ${integration}`);
    }
  }

  prepare(repoPath: string, taskId: string): WorktreeLease {
    if (!taskId.trim()) throw new Error("Boş task ID");
    const root = exactRoot(repoPath);
    if (!git(root, "rev-parse", "--verify", "HEAD").trim()) throw new Error("İlk Git commit gerekli");
    const integration = this.integration(root);
    const repoId = shortHash(root.toLowerCase());
    const taskHash = shortHash(taskId);
    const branch = `agentmesh/${repoId.slice(0, 8)}-${taskHash}`;
    const path = join(worktreesRoot(root), taskHash);
    if (existsSync(path)) throw new Error(`Worktree zaten var: ${path}`);
    git(root, "worktree", "add", "-b", branch, path, integration.branch);
    return { path, branch, baseCommit: git(path, "rev-parse", "HEAD").trim() };
  }

  reopen(repoPath: string, lease: WorktreeLease): WorktreeLease {
    const root = exactRoot(repoPath);
    if (!isAbsolute(lease.path) || !existsSync(lease.path)) throw new Error(`Worktree bulunamadı: ${lease.path}`);
    const actual = realpathSync(lease.path);
    const inside = (base: string) => actual.toLowerCase().startsWith((realpathSafe(base) + sep).toLowerCase());
    if (!inside(worktreesRoot(root)) && !inside(legacyWorktreesRoot(root))) {
      throw new Error(`Beklenmeyen worktree konumu: ${lease.path}`);
    }
    const actualBranch = git(actual, "branch", "--show-current").trim();
    if (actualBranch !== lease.branch) throw new Error("Worktree branch eşleşmiyor");
    const commonDir = git(actual, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    const expectedCommon = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    if (resolve(commonDir).toLowerCase() !== resolve(expectedCommon).toLowerCase()) {
      throw new Error("Worktree farklı repoya ait");
    }
    return { path: actual, branch: lease.branch, baseCommit: lease.baseCommit };
  }

  inspect(worktreePath: string, allowedPaths: readonly string[], baseCommit?: string): WorktreeInspection {
    const root = exactRoot(worktreePath);
    const base = this.commit(root, baseCommit ?? "HEAD");
    const tracked = git(root, "diff", "--name-only", "--no-renames", "-z", base, "--")
      .split("\0").filter(Boolean);
    const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
      .split("\0").filter(Boolean);
    const changedPaths = [...new Set([...tracked, ...untracked])].sort();
    const patterns = allowedPaths.map((pattern) => pattern.replace(/\\/g, "/"));
    const violations = changedPaths.filter((path) => {
      const normalized = path.replace(/\\/g, "/");
      const fullPath = resolve(root, path);
      let current = root;
      let symlink = false;
      for (const part of normalized.split("/")) {
        current = join(current, part);
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) symlink = true;
      }
      return !fullPath.startsWith(root + sep) || symlink || !patterns.some((pattern) => matchesGlob(normalized, pattern));
    });
    const trackedDiff = git(root, "diff", "--binary", "--no-ext-diff", "--no-renames", base, "--");
    // Content identity survives staging/committing, so a failed merge can be retried.
    const digestHash = createHash("sha256").update(base + "\n");
    const modes = new Map(git(root, "ls-files", "--stage", "-z").split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      return [line.slice(tab + 1), line.slice(0, 6)] as const;
    }));
    for (const path of changedPaths) {
      digestHash.update(JSON.stringify(path) + "\n");
      if (violations.includes(path)) { digestHash.update("violation\n"); continue; }
      const full = resolve(root, path);
      if (!existsSync(full)) { digestHash.update("deleted\n"); continue; }
      const stat = lstatSync(full);
      if (!stat.isFile()) throw new Error("Yalnızca normal dosya değişiklikleri incelenebilir");
      const mode = process.platform === "win32" ? modes.get(path) ?? "100644" : stat.mode & 0o111 ? "100755" : "100644";
      digestHash.update(mode + "\n").update(createHash("sha256").update(readFileSync(full)).digest());
    }
    const untrackedPreviews = untracked.map((path) => {
      const full = resolve(root, path);
      if (!full.startsWith(root + sep)) throw new Error(`Geçersiz dosya yolu: ${path}`);
      if (lstatSync(full).isSymbolicLink()) return {
        path, preview: "[sembolik bağlantı; açılmadı]", truncated: false, binary: true,
      };
      const contents = readFileSync(full);
      const binary = contents.includes(0);
      const truncated = contents.length > 64 * 1024;
      return {
        path,
        preview: binary ? "[binary; ayrı incelenmeli]" : contents.subarray(0, 64 * 1024).toString("utf8"),
        truncated,
        binary,
      };
    });
    return { digest: digestHash.digest("hex"), changedPaths, violations, trackedDiff, untrackedPreviews };
  }

  private commit(root: string, value: string): string {
    if (value !== "HEAD" && !/^[a-f0-9]{40,64}$/.test(value)) throw new Error("Geçersiz temel commit");
    return git(root, "rev-parse", "--verify", `${value}^{commit}`).trim();
  }

  /** Legacy leases are resolved against their branch point; new leases persist their base. */
  reviewBase(repoPath: string, lease: WorktreeLease): string {
    const verified = this.reopen(repoPath, lease);
    if (lease.baseCommit) return this.commit(verified.path, lease.baseCommit);
    const integration = this.integration(repoPath);
    return git(verified.path, "merge-base", "HEAD", integration.branch).trim();
  }

  inspectTask(repoPath: string, lease: WorktreeLease, allowedPaths: readonly string[]) {
    return this.inspect(this.reopen(repoPath, lease).path, allowedPaths, this.reviewBase(repoPath, lease));
  }

  mergeState(repoPath: string, lease: WorktreeLease) {
    const verified = this.reopen(repoPath, lease);
    const target = this.integration(repoPath);
    const integrationCommit = this.commit(target.path, "HEAD");
    const paths = git(verified.path, "diff", "--name-only", "--diff-filter=U", "-z").split("\0").filter(Boolean);
    let mergeHead: string | undefined;
    try { mergeHead = git(verified.path, "rev-parse", "--verify", "MERGE_HEAD").trim(); } catch { /* No merge in progress. */ }
    return { paths, mergeHead, integrationCommit };
  }

  validateResolution(repoPath: string, lease: WorktreeLease, allowedPaths: readonly string[], digest: string, targetCommit: string) {
    const verified = this.reopen(repoPath, lease);
    const state = this.mergeState(repoPath, lease);
    if (state.integrationCommit !== targetCommit) throw new Error("Entegrasyon dalı değişti; incelemeyi yeniden açın");
    if (state.mergeHead) throw new Error("Görevde çakışma çözümü zaten açık");
    if (git(verified.path, "status", "--porcelain").trim()) throw new Error("Çakışma çözümünden önce görev worktree'si temiz olmalı");
    const inspection = this.inspectTask(repoPath, lease, allowedPaths);
    if (inspection.digest !== digest) throw new Error("Diff değişti; incelemeyi yeniden açın");
    if (inspection.violations.length && lease.baseCommit !== targetCommit) throw new Error("Görev kapsamı dışında değişiklik var");
  }

  /** Merge approved integration history into the task; never leave integration conflicted. */
  beginResolution(repoPath: string, lease: WorktreeLease, targetCommit: string): void {
    const verified = this.reopen(repoPath, lease);
    if (this.mergeState(repoPath, lease).integrationCommit !== targetCommit) throw new Error("Entegrasyon dalı değişti; incelemeyi yeniden açın");
    try {
      git(verified.path, "-c", "core.hooksPath=", "merge", "--no-ff", "--no-commit", targetCommit);
    } catch (error) {
      if (!this.mergeState(repoPath, lease).paths.length) throw error;
      // Expected conflicts remain in this task's worktree for explicit human resolution.
    }
  }

  stageResolution(repoPath: string, lease: WorktreeLease, path: string): void {
    const verified = this.reopen(repoPath, lease);
    if (!this.mergeState(repoPath, lease).paths.includes(path)) throw new Error("Dosya artık çözülmemiş çakışma değil");
    git(verified.path, "--literal-pathspecs", "add", "--all", "--", path);
  }

  /** Called only after an explicit digest-matched approval; never merges into the user's main branch. */
  integrate(repoPath: string, lease: WorktreeLease, allowedPaths: readonly string[], approvedDigest: string, taskId: string): string {
    const verified = this.reopen(repoPath, lease);
    const inspection = this.inspectTask(repoPath, verified, allowedPaths);
    if (inspection.violations.length) throw new Error(`İzin dışı dosyalar: ${inspection.violations.join(", ")}`);
    const mergeState = this.mergeState(repoPath, verified);
    if (mergeState.paths.length) throw new Error("Çözülmemiş dosya çakışmaları var");
    const base = this.reviewBase(repoPath, verified);
    if (mergeState.mergeHead && mergeState.mergeHead !== base) throw new Error("Beklenmeyen merge hedefi; çalışma alanını inceleyin");
    if (!mergeState.mergeHead) {
      try { git(verified.path, "merge-base", "--is-ancestor", base, "HEAD"); }
      catch { throw new Error("Çözüm hedefi görev geçmişine alınmamış; çakışma çözümünü yeniden başlatın"); }
    }
    const committed = !git(verified.path, "status", "--porcelain").trim() && !mergeState.mergeHead;
    if (!lease.baseCommit && !inspection.changedPaths.length) {
      // A previous approval may have committed just before a merge conflict or interruption.
      const message = git(verified.path, "log", "-1", "--format=%B");
      if (!message.includes(`AgentMesh-Digest: ${approvedDigest}\n`)) throw new Error("İncelenen diff worktree'de bulunamadı");
    } else if (inspection.digest !== approvedDigest) {
      throw new Error("Diff onaydan sonra değişmiş; tekrar inceleyin");
    }

    const destination = this.integration(repoPath);
    if (git(destination.path, "status", "--porcelain").trim()) {
      throw new Error("Entegrasyon worktree temiz değil");
    }
    if (!committed) {
      git(verified.path, "add", "--all");
      git(verified.path, "-c", "core.hooksPath=", "-c", "user.name=AgentMesh", "-c", "user.email=agentmesh@localhost", "commit", "-m", `agentmesh: approve ${taskId}`, "-m", `AgentMesh-Digest: ${approvedDigest}`);
    }
    const taskCommit = git(verified.path, "rev-parse", "HEAD").trim();
    try {
      git(destination.path, "-c", "core.hooksPath=", "-c", "user.name=AgentMesh", "-c", "user.email=agentmesh@localhost", "merge", "--no-ff", "--no-edit", taskCommit);
    } catch (error) {
      // On conflict, leave the task branch intact and restore the integration checkout.
      const paths = git(destination.path, "diff", "--name-only", "--diff-filter=U", "-z").split("\0").filter(Boolean);
      const integrationCommit = this.commit(destination.path, "HEAD");
      if (paths.length) {
        git(destination.path, "merge", "--abort");
        throw new MergeConflictError({ paths, integrationCommit, taskCommit });
      }
      throw new Error(`Entegrasyon conflict, görev branch'i korundu: ${error instanceof Error ? error.message : String(error)}`);
    }
    return taskCommit;
  }

  /** Sadece temiz worktree'yi kaldırır; branch incelenmek üzere korunur. */
  removeClean(repoPath: string, lease: WorktreeLease): void {
    const verified = this.reopen(repoPath, lease);
    const state = this.inspect(verified.path, ["**"]);
    if (state.changedPaths.length > 0) throw new Error("Değişiklik içeren worktree kaldırılmaz");
    git(repoPath, "worktree", "remove", verified.path);
  }
}

function realpathSafe(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}
