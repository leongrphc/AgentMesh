/**
 * Real multi-agent acceptance test in a throwaway repository:
 *   multiply (math.ts) ─┐
 *                       ├─► readme (README.md, must describe both new functions)
 *   shout (strings.ts) ─┘
 * The first two run in parallel in separate worktrees; the third starts only after both are
 * approved and must see their merged code. Every approval goes through the normal review digest.
 *
 * Uses your provider account. Run: npm run e2e:team   (agent defaults to claude)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopService } from "../src/desktop/service.js";

const agentId = process.argv[2] ?? "claude";
const root = mkdtempSync(join(tmpdir(), "agentmesh-team-"));
const repo = join(root, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
writeFileSync(join(repo, "strings.ts"), "export function trim(value: string) {\n  return value.trim();\n}\n");
git("add", "-A");
git("-c", "user.name=AgentMesh E2E", "-c", "user.email=e2e@agentmesh.local", "commit", "-qm", "init");

const service = new DesktopService(join(root, "data"));
const started = Date.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;
let peakParallel = 0;
try {
  service.openFolder(repo);
  service.setParallelism(2);
  const task = (id: string, title: string, instruction: string, allowedPaths: string[], dependsOn: string[] = []) =>
    service.createTask({ id, title, instruction, agentId, dependsOn, allowedPaths });
  task("multiply", "multiply ekle", "math.ts dosyasına `export function multiply(a: number, b: number)` ekle. Başka dosyaya dokunma.", ["math.ts"]);
  task("shout", "shout ekle", "strings.ts dosyasına metni büyük harfe çevirip sonuna ! ekleyen `export function shout(value: string)` ekle. Başka dosyaya dokunma.", ["strings.ts"]);
  task("readme", "README yaz", "Depodaki math.ts ve strings.ts dosyalarını oku. README.md oluştur ve dışa aktarılan her fonksiyonu bir satırla açıkla. Yalnızca README.md'yi değiştir.",
    ["README.md"], ["multiply", "shout"]);

  let printed = 0;
  service.subscribe((current) => {
    for (const event of current.events.slice(printed)) console.log(`  ${new Date(event.at).toLocaleTimeString("tr-TR")}  ${(event.taskId ?? "proje").padEnd(8)}  ${event.text}`);
    printed = current.events.length;
    peakParallel = Math.max(peakParallel, current.snapshot.tasks.filter((item) => item.status === "running").length);
    for (const request of current.permissions) {
      service.decidePermission(request.id, request.executionId, request.digest, request.kind === "command" ? "deny" : "allow_once");
    }
  });

  const deadline = Date.now() + 10 * 60_000;
  for (let wave = 1; ; wave += 1) {
    const tasks = service.state().snapshot.tasks;
    if (tasks.every((item) => item.status === "completed")) break;
    const stuck = tasks.find((item) => ["failed", "blocked", "cancelled", "needs_review"].includes(item.status));
    if (stuck) throw new Error(`${stuck.id} durumu ${stuck.status}: ${stuck.error ?? ""}`);
    if (Date.now() > deadline) throw new Error("10 dakika içinde bitmedi");
    console.log(`\n— Dalga ${wave}: ${tasks.filter((item) => item.status === "pending").map((item) => item.id).join(", ")} —`);
    service.start();
    while (service.state().busy) {
      if (Date.now() > deadline) { service.cancel(); while (service.state().busy) await sleep(200); throw new Error("10 dakika içinde bitmedi"); }
      await sleep(500);
    }
    for (const item of service.state().snapshot.tasks.filter((candidate) => candidate.status === "pending_review")) {
      const review = service.review(item.id);
      if (!review.canApprove) throw new Error(`${item.id} onaylanamıyor: ${review.inspection.violations.join(", ") || "durum uyumsuz"}`);
      console.log(`  İnceleme ${item.id}: ${review.inspection.changedPaths.join(", ")} → onaylandı`);
      service.approve(item.id, review.inspection.digest);
    }
  }

  const integration = service.state().integrationBranch!;
  const show = (path: string) => git("show", `${integration}:${path}`);
  if (!/multiply/.test(show("math.ts"))) throw new Error("multiply entegrasyon dalında yok");
  if (!/shout/.test(show("strings.ts"))) throw new Error("shout entegrasyon dalında yok");
  const readme = show("README.md");
  if (!/multiply/.test(readme) || !/shout/.test(readme)) throw new Error("README bağımlı görevlerin kodunu görmemiş:\n" + readme);
  if (peakParallel < 2) throw new Error(`Bağımsız görevler paralel çalışmadı (en fazla ${peakParallel})`);
  console.log(`\nREADME.md (${integration}):\n${readme}`);
  console.log(`\nBAŞARILI: 3 görev, en fazla ${peakParallel} paralel ajan, ${((Date.now() - started) / 1000).toFixed(0)} sn.`);
} catch (error) {
  failed = true;
  console.error(`\nBAŞARISIZ: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await service.close();
  if (failed) console.error(`İnceleme için bırakıldı: ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
