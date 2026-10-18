import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SqliteJournal } from "./core/sqlite-journal.js";
import { Orchestrator } from "./core/orchestrator.js";
import { WorktreeManager } from "./core/worktrees.js";
import { configuredAdapter } from "./adapters/registry.js";
import { validate, reconcileTasks, type Config } from "./core/config.js";
import { diagnosticReport } from "./core/diagnostics.js";
import { safeLog } from "./core/safe-log.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reviewing = args.includes("--review");
  const approving = args.includes("--approve");
  const retrying = args.includes("--retry");
  const executing = args.includes("--execute");
  const streaming = args.includes("--stream");
  const diagnostics = args.includes("--diagnostics");
  if (Number(reviewing) + Number(approving) + Number(retrying) + Number(executing) + Number(diagnostics) > 1) {
    throw new Error("--review, --approve, --retry ve --execute birlikte kullanılamaz");
  }
  if (streaming && !executing) throw new Error("--stream yalnızca --execute ile kullanılabilir");
  const configIndex = args.indexOf("--config");
  const configArg = args[configIndex + 1];
  if (configIndex < 0 || !configArg) {
    throw new Error("Kullanım: npm run live -- --config .\\agentmesh.config.json [--execute [--stream] | --review | --approve TASK --digest SHA256 | --retry TASK]");
  }
  const configFile = resolve(configArg);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Config;
  validate(config);
  const needsDesktop = config.agents.some((agent) => agent.transport && agent.transport !== "exec");
  if (executing && needsDesktop) {
    throw new Error("Etkileşimli izin kararları için bu config'i masaüstü uygulamasında açın; CLI yalnızca exec transport çalıştırır");
  }
  const repoPath = isAbsolute(config.repoPath)
    ? realpathSync(config.repoPath) : realpathSync(resolve(dirname(configFile), config.repoPath));
  if (!executing && !reviewing && !approving && !retrying && !diagnostics) {
    console.log(JSON.stringify({
      dryRun: true, repoPath, projectId: config.projectId,
      agents: config.agents, tasks: config.tasks.map(({ id, agentId, dependsOn, allowedPaths }) => ({ id, agentId, dependsOn, allowedPaths })),
      instruction: needsDesktop
        ? "Bu config etkileşimli izin gerektirir; çalıştırmak için masaüstü uygulamasında açın. CLI --review, --approve ve --retry komutları kullanılabilir."
        : "--execute [--stream]: ajanları çalıştır, --review: diff görüntüle, --approve TASK --digest SHA256: onayla, --retry TASK: görevi yeniden kuyruğa al.",
    }, null, 2));
    return;
  }
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Gerçek çalıştırma için ilk commit'i yapılmış Git deposu gerekli: ${repoPath}`);
  }
  const repoKey = createHash("sha256").update(repoPath.toLowerCase()).digest("hex").slice(0, 16);
  const dbPath = join(dirname(repoPath), ".agentmesh-data", repoKey, "events.sqlite");
  const journal = new SqliteJournal(dbPath);
  try {
    if (diagnostics) {
      const events = journal.all().filter(({ payload }) =>
        (payload.type === "project.created" ? payload.project.id
          : payload.type === "task.created" ? payload.task.projectId : payload.projectId) === config.projectId);
      console.log(JSON.stringify(diagnosticReport(events), null, 2));
      return;
    }
    const manager = new WorktreeManager();
    const engine = new Orchestrator(journal, manager);
    if (streaming) engine.subscribe((notice) => {
      console.log(JSON.stringify(notice));
    });
    for (const agent of config.agents) {
      engine.registerAgent(configuredAdapter(agent));
    }
    let existing;
    try { existing = engine.snapshot(config.projectId); }
    catch {
      if (!executing) throw new Error(needsDesktop ? "Önce bu projeyi masaüstü uygulamasında açın" : "Önce --execute ile projeyi oluşturmalısınız");
      engine.createProject({ id: config.projectId, workspaceRoot: repoPath });
    }
    existing = engine.snapshot(config.projectId);
    if (realpathSync(existing.project.workspaceRoot).toLowerCase() !== repoPath.toLowerCase()) {
      throw new Error("Proje kimliği başka depo ile eşleşiyor");
    }
    if (executing) {
      const reserved = journal.all().flatMap(({ payload }) => payload.type === "task.created" && payload.task.projectId !== config.projectId ? [payload.task.id] : []);
      for (const task of reconcileTasks(config, existing.tasks, reserved)) engine.addTask(task);
    }
    if (approving) {
      const taskId = args[args.indexOf("--approve") + 1];
      const digest = args[args.indexOf("--digest") + 1];
      if (!taskId || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error("Onay için --approve TASK_ID --digest SHA256 gereklidir");
      }
      const commit = engine.approveTask(taskId, digest);
      console.log(JSON.stringify({ approved: taskId, taskCommit: commit, instruction: "Bağımlı görevleri çalıştırmak için ayrıca --execute kullanın." }, null, 2));
      return;
    }
    if (retrying) {
      const taskId = args[args.indexOf("--retry") + 1];
      if (!taskId || taskId.startsWith("--")) throw new Error("Yeniden deneme için --retry TASK_ID gerekli");
      engine.retryTask(taskId);
      console.log(JSON.stringify({ retried: taskId, status: "pending", instruction: "Yeniden başlatmak için --execute kullanın. Önce kısmi worktree değişikliklerini inceleyin." }, null, 2));
      return;
    }
    let snapshot;
    if (executing) {
      const abort = new AbortController();
      const onSigint = () => {
        console.error("SIGINT: çalışan ve bekleyen görevler iptal ediliyor");
        abort.abort();
      };
      process.on("SIGINT", onSigint);
      try { snapshot = await engine.run(config.projectId, config.maxParallel ?? existing.project.maxParallel ?? 2, abort.signal); }
      finally { process.off("SIGINT", onSigint); }
    } else snapshot = engine.snapshot(config.projectId);
    const reports = snapshot.tasks.map((task) => {
      const changes = task.worktree && existsSync(task.worktree.path)
        ? manager.inspect(task.worktree.path, task.allowedPaths)
        : undefined;
      return {
        id: task.id, agentId: task.agentId, status: task.status,
        summary: task.summary, error: task.error, sessionId: task.sessionId,
        worktree: task.worktree,
        reviewDigest: task.review?.digest,
        changedPaths: changes?.changedPaths,
        violations: changes?.violations,
        ...(reviewing ? { trackedDiff: changes?.trackedDiff, untrackedPreviews: changes?.untrackedPreviews } : {}),
      };
    });
    console.log(JSON.stringify({ dbPath, mode: reviewing ? "review" : "execute", reports }, null, streaming ? 0 : 2));
    if (reports.some((task) => task.status === "cancelled")) process.exitCode = 130;
    else if (reports.some((task) => task.status === "failed" || task.status === "blocked" || task.status === "needs_review")) process.exitCode = 1;
  } finally { journal.close(); }
}

main().catch((error: unknown) => {
  console.error(safeLog(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
