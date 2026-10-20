import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";

const maxFileBytes = 1024 * 1024;
const hidden = new Set([".git", "node_modules", ".agentmesh", ".agentmesh-data", ".agentmesh-worktrees"]);

export interface WorkspaceEntry { path: string; name: string; directory: boolean }
export interface WorkspaceFile { path: string; content: string; digest: string; writable: boolean }

/** Every path is relative to a verified workspace. Symlinks/junctions and ADS are excluded. */
function checkedPath(root: string, path: string, allowMissingLeaf = false): string {
  if (typeof path !== "string" || path.includes("\0") || path.includes(":") || isAbsolute(path)) throw new Error("Geçersiz dosya yolu");
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === "." || hidden.has(part.toLowerCase()) || /[. ]$/.test(part)
    || /[<>"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Çalışma alanı dışı veya korunan dosya yolu");
  }
  const realRoot = realpathSync(root);
  let target = realRoot;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    if (allowMissingLeaf && index === parts.length - 1) {
      try { lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    }
    if (lstatSync(target).isSymbolicLink()) throw new Error("Sembolik bağlantı açılamaz");
  }
  const delta = relative(realRoot, allowMissingLeaf && !existsSync(target) ? target : realpathSync(target));
  if (delta.startsWith(`..${sep}`) || delta === ".." || isAbsolute(delta)) throw new Error("Çalışma alanı dışı yol");
  return target;
}

export interface ConflictFile { path: string; content: string | null; digest: string | null; binary: boolean }

/** Exclusive leaf creation; parents must already exist and pass the same path checks. */
export function createWorkspaceEntry(root: string, path: string, directory: boolean, allowedPaths: readonly string[]): WorkspaceEntry {
  if (typeof path !== "string" || !path || path.length > 1024 || typeof directory !== "boolean") throw new Error("Geçersiz yeni dosya yolu");
  const normalized = path.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => !part)) throw new Error("Yeni öğe için göreli ve boş olmayan bir yol girin");
  const target = checkedPath(root, normalized, true);
  const permitted = allowedPaths.some((raw) => {
    const pattern = raw.replace(/\\/g, "/");
    if (!directory) return matchesGlob(normalized, pattern);
    // A directory can match a prefix of an allowed file pattern, including globstar.
    const segments = pattern.split("/");
    return segments.some((_part, index) => matchesGlob(normalized, segments.slice(0, index + 1).join("/")));
  });
  if (!permitted) throw new Error("Yeni öğe görev kapsamı dışında");
  if (directory) mkdirSync(target);
  else writeFileSync(target, "", { encoding: "utf8", flag: "wx" });
  return { path: normalized, name: normalized.split("/").at(-1)!, directory };
}

export function readConflictFile(root: string, path: string): ConflictFile {
  const target = checkedPath(root, path, true);
  if (!existsSync(target)) return { path, content: null, digest: null, binary: false };
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > maxFileBytes) throw new Error("Çakışma editörü yalnızca 1 MiB altındaki dosyaları destekler");
  const bytes = readFileSync(target);
  if (bytes.length > maxFileBytes) throw new Error("Dosya çok büyük");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let content: string | null = null;
  if (!bytes.includes(0)) {
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { /* Binary or non-UTF8. */ }
  }
  return { path, digest, content, binary: content === null };
}

export function writeConflictResolution(root: string, path: string, content: string | null, digest: string | null, allowedPaths: readonly string[], keepCurrent = false) {
  if (!allowedPaths.some((pattern) => matchesGlob(path, pattern.replace(/\\/g, "/")))) throw new Error("Dosya görev kapsamı dışında");
  if (content !== null && (typeof content !== "string" || Buffer.byteLength(content) > maxFileBytes || content.includes("\0"))) throw new Error("Geçersiz veya büyük dosya içeriği");
  if (content !== null && /^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(content)) throw new Error("Çakışma işaretlerini kaldırıp çözümü tekrar kaydedin");
  const current = readConflictFile(root, path);
  if (current.digest !== digest) throw new Error("Dosya disk üzerinde değişti; yeniden açın");
  if (keepCurrent) {
    if (current.content !== null && /^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(current.content)) throw new Error("Çakışma işaretlerini kaldırın");
    return;
  }
  const target = checkedPath(root, path, true);
  if (content === null) { if (existsSync(target)) unlinkSync(target); }
  else writeFileSync(target, content, "utf8");
}

export function listWorkspace(root: string, path = ""): WorkspaceEntry[] {
  const directory = checkedPath(root, path);
  if (!lstatSync(directory).isDirectory()) throw new Error("Klasör seçin");
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > 5000) throw new Error("Klasörde çok fazla dosya var (en fazla 5000)");
  return entries.filter((entry) => !hidden.has(entry.name) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
    .map((entry) => ({ name: entry.name, path: (path ? `${path}/` : "") + entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export function readWorkspaceFile(root: string, path: string): WorkspaceFile {
  const target = checkedPath(root, path);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > maxFileBytes) throw new Error("Yalnızca 1 MiB altındaki metin dosyaları açılabilir");
  const data = readFileSync(target);
  if (data.length > maxFileBytes || data.includes(0)) throw new Error("İkili veya büyük dosya editörde açılamaz");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new Error("Dosya UTF-8 değil; harici editörle açın"); }
  return { path, content, digest: createHash("sha256").update(data).digest("hex"), writable: false };
}

export function saveWorkspaceFile(root: string, path: string, content: string, expectedDigest: string, allowedPaths: readonly string[]): WorkspaceFile {
  if (typeof content !== "string" || Buffer.byteLength(content) > maxFileBytes || content.includes("\0")) throw new Error("Geçersiz veya büyük dosya içeriği");
  const normalized = path.replace(/\\/g, "/");
  if (!allowedPaths.some((pattern) => matchesGlob(normalized, pattern.replace(/\\/g, "/")))) throw new Error("Dosya görev kapsamı dışında");
  const current = readWorkspaceFile(root, path);
  if (current.digest !== expectedDigest) throw new Error("Dosya disk üzerinde değişti; kaydetmeden önce yeniden açın");
  writeFileSync(checkedPath(root, path), content, "utf8");
  return { ...readWorkspaceFile(root, path), writable: true };
}
