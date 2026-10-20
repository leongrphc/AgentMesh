import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { copyFile } from "node:fs/promises";
import { checkRendererBudget } from "./renderer-budget.mjs";

await build({ entryPoints: { main: "src/desktop/main.ts", preload: "src/desktop/preload.ts" },
  bundle: true, platform: "node", target: "node22", format: "cjs", outdir: "dist/desktop",
  define: { "import.meta.dirname": "__dirname" },
  outExtension: { ".js": ".cjs" }, external: ["electron", "node-pty"], sourcemap: true });
await buildRenderer();
checkRendererBudget();
await copyFile("src/desktop/terminal-host.cjs", "dist/desktop/terminal-host.cjs");
