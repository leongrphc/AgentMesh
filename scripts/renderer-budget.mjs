import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Check the emitted graph, not source spelling: shared static imports count too. */
export function checkRendererBudget(root = "dist/renderer") {
  const manifest = JSON.parse(readFileSync(join(root, ".vite/manifest.json"), "utf8"));
  const startup = new Set();
  function visit(key) {
    if (startup.has(key)) return;
    if (!manifest[key]) throw new Error(`Missing build entry: ${key}`);
    startup.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  }
  // These panels mount on the initial desktop route, even though React loads them lazily.
  for (const key of ["index.html", "editor.tsx", "terminal.tsx"]) visit(key);
  if (startup.has("monaco-runtime.ts")) throw new Error("Monaco returned to the startup dependency graph");
  if (!manifest["editor.tsx"].dynamicImports?.includes("monaco-runtime.ts")) throw new Error("Missing deferred Monaco boundary");
  const size = (file) => statSync(join(root, file)).size;
  const js = new Set([...startup].map((key) => manifest[key].file));
  const css = new Set([...startup].flatMap((key) => manifest[key].css ?? []));
  const sum = (files) => [...files].reduce((total, file) => total + size(file), 0);
  const report = {
    startupJavaScriptBytes: sum(js), startupCssBytes: sum(css),
    editorShellBytes: size(manifest["editor.tsx"].file),
    deferredMonacoBytes: size(manifest["monaco-runtime.ts"].file),
    startupFiles: [...js, ...css],
  };
  if (report.startupJavaScriptBytes > 800 * 1024 || report.startupCssBytes > 40 * 1024
    || report.editorShellBytes > 64 * 1024 || report.deferredMonacoBytes > 3 * 1024 * 1024) {
    throw new Error(`Renderer budget exceeded: ${JSON.stringify(report)}`);
  }
  writeFileSync("dist/renderer-budget.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`Renderer budget: startup JS ${report.startupJavaScriptBytes} B; editor shell ${report.editorShellBytes} B; deferred Monaco ${report.deferredMonacoBytes} B`);
  return report;
}
