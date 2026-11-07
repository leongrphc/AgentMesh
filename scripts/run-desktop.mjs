import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["dist/desktop/main.cjs", ...process.argv.slice(2)], {
  stdio: "inherit", env, windowsHide: process.argv.includes("--smoke-test"),
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
const smoke = process.argv.slice(2).some((arg) => arg.endsWith("smoke-test"));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
  // The Electron main process names its smoke data folder after its pid. Remove it only after
  // a successful run (files are unlocked once the process has exited); failures keep it for debugging.
  if (smoke && code === 0 && child.pid) {
    rmSync(join(".agentmesh", "desktop-smoke", String(child.pid)), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
