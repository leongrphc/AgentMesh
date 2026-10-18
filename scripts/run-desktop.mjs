import { spawn } from "node:child_process";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["dist/desktop/main.cjs", ...process.argv.slice(2)], {
  stdio: "inherit", env, windowsHide: process.argv.includes("--smoke-test"),
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
