import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("Windows paket kabulü Windows üzerinde çalıştırılmalıdır.");
if (process.argv.length !== 3) throw new Error("Kullanım: npm run desktop:package:smoke -- <paket-klasörü>");
const source = resolve(process.argv[2]);
const info = JSON.parse(await readFile(join(source, "build-info.json"), "utf8"));
if (info.platform !== process.platform || info.arch !== process.arch) throw new Error("Paket platformu/mimarisi bu bilgisayarla eşleşmiyor.");
// A path outside the repository prevents missing dependencies from resolving
// accidentally through the development checkout's parent node_modules.
const directory = await mkdtemp(join(tmpdir(), "AgentMesh-package-smoke-"));
const app = join(directory, "application");
await cp(source, app, { recursive: true });
await mkdir(join(directory, "dist"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (["ELECTRON_RUN_AS_NODE", "NODE_PATH", "NODE_OPTIONS"].includes(key.toUpperCase())) delete env[key];
}
console.log(`Paket kabul çalışma alanı: ${directory}`);
let stdout = "", stderr = "", timedOut = false;
const child = spawn(join(app, "AgentMesh.exe"), ["--smoke-test"], { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on("data", chunk => { stderr += chunk; process.stderr.write(chunk); });
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
let code;
try {
  code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
} finally {
  clearTimeout(timer);
  await writeFile(join(directory, "stdout.log"), stdout);
  await writeFile(join(directory, "stderr.log"), stderr);
}
const passed = !timedOut && code === 0 && stdout.includes("Desktop smoke başarılı:");
await writeFile(join(directory, "result.json"), JSON.stringify({ source, version: info.version, passed, code, timedOut }, null, 2));
if (!passed) throw new Error(`Paket kabulü başarısız (exit=${code}, timeout=${timedOut}). Kayıtlar: ${directory}`);
console.log(`Paket kabulü başarılı. Kayıtlar ve ekran görüntüleri: ${directory}`);
