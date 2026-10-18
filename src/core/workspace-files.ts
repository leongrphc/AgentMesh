import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";

const maxFileBytes = 1024 * 1024;
const hidden = new Set([".git", "node_modules", ".agentmesh", ".agentmesh-data", ".agentmesh-worktrees"]);

export interface WorkspaceEntry { path: string; name: string; directory: boolean }
export interface WorkspaceFile { path: string; content: string; digest: string; writable: boolean }

/** Every path is relative to a verified workspace. Symlinks/junctions and ADS are excluded. */
function checkedPath(root: string, path: string): string {
  if (typeof path !== "string" || path.includes("\0") || path.includes(":") || isAbsolute(path)) throw new Error("Geçersiz dosya yolu");
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === "." || hidden.has(part) || /[. ]$/.test(part))) {
    throw new Error("Çalışma alanı dışı veya korunan dosya yolu");
  }
  const realRoot = realpathSync(root);
  let target = realRoot;
  for (const part of parts) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink()) throw new Error("Sembolik bağlantı açılamaz");
  }
  const delta = relative(realRoot, realpathSync(target));
  if (delta.startsWith(`..${sep}`) || delta === ".." || isAbsolute(delta)) throw new Error("Çalışma alanı dışı yol");
  return target;
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
