import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
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

/** Ayrı branch/worktree üretir. Repoya otomatik merge veya force-delete yapmaz. */
export class WorktreeManager {
  integration(repoPath: string): WorktreeLease {
    const root = exactRoot(repoPath);
    const repoId = shortHash(root.toLowerCase());
    const branch = `agentmesh/integration-${repoId.slice(0, 8)}`;
    const path = join(dirname(root), ".agentmesh-worktrees", repoId, "integration");
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

  prepare(repoPath: string, taskId: string): WorktreeLease {
    if (!taskId.trim()) throw new Error("Boş task ID");
    const root = exactRoot(repoPath);
    if (!git(root, "rev-parse", "--verify", "HEAD").trim()) throw new Error("İlk Git commit gerekli");
    const integration = this.integration(root);
    const repoId = shortHash(root.toLowerCase());
    const taskHash = shortHash(taskId);
    const branch = `agentmesh/${repoId.slice(0, 8)}-${taskHash}`;
    const path = join(dirname(root), ".agentmesh-worktrees", repoId, taskHash);
    if (existsSync(path)) throw new Error(`Worktree zaten var: ${path}`);
    git(root, "worktree", "add", "-b", branch, path, integration.branch);
    return { path, branch, baseCommit: git(path, "rev-parse", "HEAD").trim() };
  }

  reopen(repoPath: string, lease: WorktreeLease): WorktreeLease {
    const root = exactRoot(repoPath);
    if (!isAbsolute(lease.path) || !existsSync(lease.path)) throw new Error(`Worktree bulunamadı: ${lease.path}`);
    const expectedRoot = join(dirname(root), ".agentmesh-worktrees", shortHash(root.toLowerCase()));
    const actual = realpathSync(lease.path);
    if (!actual.toLowerCase().startsWith((realpathSafe(expectedRoot) + sep).toLowerCase())) {
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
