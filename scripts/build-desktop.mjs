import { build } from "esbuild";
import { build as buildRenderer } from "vite";

await build({ entryPoints: { main: "src/desktop/main.ts", preload: "src/desktop/preload.ts" },
  bundle: true, platform: "node", target: "node22", format: "cjs", outdir: "dist/desktop",
  outExtension: { ".js": ".cjs" }, external: ["electron"], sourcemap: true });
await buildRenderer();
