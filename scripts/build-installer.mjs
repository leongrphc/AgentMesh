/**
 * Wraps the newest portable package (npm run desktop:package) in a Windows installer:
 * per-user install without admin rights, chosen folder, desktop and Start menu shortcuts,
 * and an uninstaller that keeps the user's projects and app data.
 * Output: dist/installers/AgentMesh-Setup-<version>.exe (unsigned).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("Windows kurulum dosyası Windows üzerinde üretilir.");
const root = resolve(import.meta.dirname, "..");
const releases = join(root, "dist", "releases");
const newest = readdirSync(releases)
  .map((name) => join(releases, name))
  .filter((path) => statSync(path).isDirectory())
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!newest) throw new Error("Önce taşınabilir paketi üretin: npm run desktop:package");
console.log(`Kurulum dosyasına dönüştürülen paket: ${newest}`);
const builder = join(root, "node_modules", ".bin", "electron-builder.cmd");
const result = spawnSync(builder, ["--win", "nsis", "--x64", "--prepackaged", newest, "--config", "build/installer.json", "--publish", "never"],
  { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
process.exit(result.status ?? 1);
