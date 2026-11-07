/**
 * Real end-to-end acceptance test: one coding task in a throwaway Git repository.
 * Opens the repo as a folder project, runs a tiny task with the chosen agent, inspects the diff,
 * approves it and checks that the change reached the integration branch.
 *
 * Uses your provider account and quota. Run: npm run e2e:claude  or  npm run e2e:codex
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopService } from "../src/desktop/service.js";
import { listCodexProfiles } from "../src/adapters/codex-profiles.js";

const agentId = process.argv[2] ?? "claude";
const profileName = process.argv[3];
if (!["claude", "codex"].includes(agentId) || (profileName && agentId !== "codex")) throw new Error("Kullanım: tsx scripts/e2e.ts <claude | codex [profil]>");
const profile = profileName ? listCodexProfiles().find((item) => item.name === profileName) : undefined;
if (profileName && !profile) throw new Error(`Codex profili bulunamadı: ${profileName} (bulunanlar: ${listCodexProfiles().map((item) => item.name).join(", ") || "yok"})`);
const root = mkdtempSync(join(tmpdir(), "agentmesh-e2e-"));
const repo = join(root, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
git("add", "-A");
git("-c", "user.name=AgentMesh E2E", "-c", "user.email=e2e@agentmesh.local", "commit", "-qm", "init");

const service = new DesktopService(join(root, "data"));
const started = Date.now();
let failed = false;
try {
  let state = service.openFolder(repo);
  if (profile) {
    service.saveAgent({ id: "codex", provider: "codex", transport: "app-server", codexHome: profile.path });
    state = service.state();
  }
  console.log(`Proje: ${state.snapshot.project.id} · ajan: ${state.agents.map((agent) => `${agent.id} (${agent.provider}/${agent.transport ?? "exec"}${agent.codexHome ? ` · ${agent.codexHome}` : ""})`).join(", ")}`);
  service.createTask({
    id: "multiply", title: "multiply fonksiyonu ekle", agentId, dependsOn: [], allowedPaths: state.defaultAllowedPaths,
    instruction: "math.ts dosyasına iki sayıyı çarpan `export function multiply(a: number, b: number)` fonksiyonunu ekle. Başka dosya değiştirme.",
  });
  let printed = 0;
  service.subscribe((current) => {
    for (const event of current.events.slice(printed)) console.log(`  ${new Date(event.at).toLocaleTimeString("tr-TR")}  ${event.text}`);
    printed = current.events.length;
    // Only file edits inside the task worktree are allowed; shell commands are denied.
    for (const request of current.permissions) {
      service.decidePermission(request.id, request.executionId, request.digest, request.kind === "command" ? "deny" : "allow_once");
    }
  });
  service.start();
  const deadline = Date.now() + 5 * 60_000;
  while (service.state().busy) {
    if (Date.now() > deadline) {
      service.cancel();
      while (service.state().busy) await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error("5 dakika içinde bitmedi; görev iptal edildi. Yukarıdaki sağlayıcı hatalarına bakın.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const task = service.state().snapshot.tasks[0]!;
  console.log(`\nDurum: ${task.status} (${((Date.now() - started) / 1000).toFixed(1)} sn)`);
  if (task.status !== "pending_review") throw new Error(`Beklenen pending_review, gelen ${task.status}: ${task.error ?? ""}`);
  const review = service.review(task.id);
  console.log(`Değişen dosyalar: ${review.inspection.changedPaths.join(", ")}\n${review.inspection.trackedDiff}`);
  if (!review.canApprove) throw new Error("İnceleme onaylanabilir değil");
  service.approve(task.id, review.inspection.digest);
  const merged = service.state().snapshot.tasks[0]!;
  if (merged.status !== "completed") throw new Error(`Onay sonrası durum ${merged.status}`);
  const branches = git("branch", "--list", "agentmesh/*", "--format=%(refname:short)").split("\n");
  const integration = branches.find((name) => name.includes("integration"));
  const content = integration ? git("show", `${integration}:math.ts`) : "";
  if (!/multiply/.test(content)) throw new Error(`multiply entegrasyon dalında yok (dallar: ${branches.join(", ")})`);
  // Everything AgentMesh writes for the project must stay inside the selected folder.
  const outside = readdirSync(root).filter((name) => name !== "repo" && name !== "data");
  if (outside.length) throw new Error(`Seçilen klasörün dışına yazıldı: ${outside.join(", ")}`);
  if (!task.worktree?.path.toLowerCase().startsWith(join(realpathSync(repo), ".agentmesh").toLowerCase())) {
    throw new Error(`Görev çalışma alanı klasör dışında: ${task.worktree?.path}`);
  }
  const applied = service.applyIntegration();
  if (!/multiply/.test(readFileSync(join(repo, "math.ts"), "utf8"))) throw new Error("Projeme uygula sonrası math.ts değişmedi");
  if (git("status", "--porcelain")) throw new Error("Uygulama sonrası depo temiz değil");
  console.log(`\nBAŞARILI: değişiklik ${integration} dalından "${applied.branch}" dalına ${applied.fastForward ? "eklendi" : "birleştirildi"}; math.ts klasörde güncel.`);
} catch (error) {
  failed = true;
  console.error(`\nBAŞARISIZ: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await service.close();
  if (failed) console.error(`İnceleme için bırakıldı: ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
