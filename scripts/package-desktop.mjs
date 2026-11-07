import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

// Keep native ConPTY files outside ASAR so the terminal host can load them.
if (process.platform !== "win32") throw new Error("Windows paketi Windows üzerinde oluşturulmalıdır.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releases = join(root, "dist", "releases");
await mkdir(releases, { recursive: true });
const output = await mkdtemp(join(releases, `AgentMesh-${manifest.version}-win-${process.arch}-`));
await cp(join(dirname(require.resolve("electron/package.json")), "dist"), output, { recursive: true });
await rename(join(output, "electron.exe"), join(output, "AgentMesh.exe"));
// The executable carries the AgentMesh icon and name instead of Electron's (taskbar, Start menu, Explorer).
const rcedit = require("rcedit");
await rcedit(join(output, "AgentMesh.exe"), {
  icon: join(root, "build", "icon.ico"),
  "file-version": manifest.version, "product-version": manifest.version,
  "version-string": { ProductName: "AgentMesh", FileDescription: "AgentMesh", CompanyName: "AgentMesh", OriginalFilename: "AgentMesh.exe", InternalName: "AgentMesh" },
});
const app = join(output, "resources", "app");
await mkdir(app, { recursive: true });
await writeFile(join(app, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, main: "dist/desktop/main.cjs" }, null, 2));
for (const directory of ["desktop", "renderer"]) {
  await cp(join(root, "dist", directory), join(app, "dist", directory), { recursive: true });
}
const copied = new Set();
async function copyDependency(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = dirname(require.resolve(`${name}/package.json`));
  const dependency = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await cp(source, join(app, "node_modules", name), { recursive: true });
  for (const child of Object.keys(dependency.dependencies ?? {})) await copyDependency(child);
}
await copyDependency("node-pty");
const notices = [], noticed = new Set();
async function collectNotices(name) {
  if (noticed.has(name)) return;
  noticed.add(name);
  const source = join(root, "node_modules", name);
  const dependency = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  notices.push(`\n=== ${name} ${dependency.version} (${dependency.license ?? "see license"}) ===\n`);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && /^(license|licence|notice|thirdpartynotices)(\.|$)/i.test(entry.name)) {
      notices.push(await readFile(join(source, entry.name), "utf8"));
    }
  }
  for (const child of Object.keys(dependency.dependencies ?? {})) await collectNotices(child);
}
for (const name of Object.keys(manifest.dependencies)) await collectNotices(name);
await writeFile(join(output, "THIRD-PARTY-NOTICES.txt"), notices.join("\n"));
await cp(join(root, "docs", "TRYOUT.md"), join(output, "TRYOUT.md"));
await writeFile(join(output, "README.txt"), "AgentMesh.exe ile açın. Tüm klasörü birlikte taşıyın. Node/npm gerekmez. Gerçek projeler için Git ve seçilen sağlayıcının CLI kurulumu gerekir. Demo model çağırmaz. Bu paket imzasız yerel deneme sürümüdür; otomatik güncelleme içermez.\r\n");
const digest = createHash("sha256").update(await readFile(join(output, "AgentMesh.exe"))).digest("hex");
await writeFile(join(output, "build-info.json"), JSON.stringify({ version: manifest.version, platform: process.platform, arch: process.arch, electron: require("electron/package.json").version, executableSha256: digest }, null, 2));
console.log(`Windows deneme paketi: ${output}`);
