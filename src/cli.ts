import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SqliteJournal } from "./core/sqlite-journal.js";
import { Orchestrator } from "./core/orchestrator.js";
import { WorktreeManager } from "./core/worktrees.js";
import { configuredAdapter } from "./adapters/registry.js";
import { validate, reconcileTasks, type Config } from "./core/config.js";
import { diagnosticReport } from "./core/diagnostics.js";
import { safeLog } from "./core/safe-log.js";
import { resolveAgentSettings } from "./core/agent-settings.js";
import { verifyJournalArchive } from "./core/journal-archive.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reviewing = args.includes("--review");
  const approving = args.includes("--approve");
  const retrying = args.includes("--retry");
  const executing = args.includes("--execute");
  const streaming = args.includes("--stream");
  const diagnostics = args.includes("--diagnostics");
  const contextReview = args.includes("--context");
  const resolvingContext = args.includes("--resolve-context");
  const archiving = args.includes("--archive");
  const verifyingArchive = args.includes("--verify-archive");
  const checkpointing = args.includes("--checkpoint");
  const compacting = args.includes("--compact");
  if ([reviewing, approving, retrying, executing, diagnostics, contextReview, resolvingContext, archiving, verifyingArchive, checkpointing, compacting].filter(Boolean).length > 1) {
    throw new Error("İnceleme, çalıştırma ve karar komutlarını ayrı kullanın");
  }
  if (streaming && !executing) throw new Error("--stream yalnızca --execute ile kullanılabilir");
  const archiveArg = args[args.indexOf(compacting ? "--compact" : archiving ? "--archive" : "--verify-archive") + 1];
  if ((archiving || verifyingArchive || compacting) && (!archiveArg || archiveArg.startsWith("--"))) throw new Error("Arşiv komutu için dosya yolu gerekli");
  if (verifyingArchive) {
    console.log(JSON.stringify({ verified: true, path: resolve(archiveArg!), ...verifyJournalArchive(resolve(archiveArg!)) }, null, 2));
    return;
  }
  const configIndex = args.indexOf("--config");
  const configArg = args[configIndex + 1];
  if (configIndex < 0 || !configArg) {
    throw new Error("Kullanım: npm run live -- --config .\\agentmesh.config.json [--execute [--stream] | --review | --approve TASK --digest SHA256 | --retry TASK | --context | --resolve-context ID --revision N --choice keep|accept|custom [--value-file UTF8_FILE]]");
  }
  const configFile = resolve(configArg);
  let config = JSON.parse(readFileSync(configFile, "utf8")) as Config;
  validate(config);
  const needsDesktop = config.agents.some((agent) => agent.transport && agent.transport !== "exec");
  const repoPath = isAbsolute(config.repoPath)
    ? realpathSync(config.repoPath) : realpathSync(resolve(dirname(configFile), config.repoPath));
  if (!executing && !reviewing && !approving && !retrying && !diagnostics && !contextReview && !resolvingContext && !archiving && !checkpointing && !compacting) {
    console.log(JSON.stringify({
      dryRun: true, repoPath, projectId: config.projectId,
      agents: config.agents, tasks: config.tasks.map(({ id, agentId, dependsOn, allowedPaths, contextKeys }) => ({ id, agentId, dependsOn, allowedPaths, contextKeys })),
      instruction: needsDesktop
        ? "Bu config etkileşimli izin gerektirir; çalıştırmak için masaüstü uygulamasında açın. CLI --review, --approve ve --retry komutları kullanılabilir."
        : "--execute [--stream]: ajanları çalıştır, --review: diff görüntüle, --approve TASK --digest SHA256: onayla, --retry TASK: görevi yeniden kuyruğa al.",
      contextInstruction: "--context: sürüm ve çakışmaları incele; --resolve-context ID --revision N --choice keep|accept|custom: karar ver. custom için --value-file UTF8_FILE gerekir.",
      archiveInstruction: "--archive YENI_DOSYA.sqlite: journal'ın doğrulanan tam kopyasını oluşturur; kaynak kayıtlarını silmez. --verify-archive DOSYA.sqlite config gerektirmeden doğrular.",
      checkpointInstruction: "--checkpoint: kurtarma sonrası mevcut durumun açılış önbelleğini kaydeder; olayları silmez ve ajan çalıştırmaz.",
      compactInstruction: "--compact YENI_ARSIV.sqlite: doğrulanan arşive bağlanır ve aktif journal'ı küçültür. Bağlı arşiv artık çalışma için zorunludur.",
    }, null, 2));
    return;
  }
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Gerçek çalıştırma için ilk commit'i yapılmış Git deposu gerekli: ${repoPath}`);
  }
  const repoKey = createHash("sha256").update(repoPath.toLowerCase()).digest("hex").slice(0, 16);
  const dbPath = join(dirname(repoPath), ".agentmesh-data", repoKey, "events.sqlite");
  if ((archiving || checkpointing || compacting) && !existsSync(dbPath)) throw new Error("Journal bulunamadı; önce projeyi açın");
  const journal = new SqliteJournal(dbPath);
  try {
    if (archiving) {
      console.log(JSON.stringify({ archived: true, ...journal.archive(archiveArg!) }, null, 2));
      return;
    }
    if (diagnostics) {
      const events = journal.scan(config.projectId);
      console.log(JSON.stringify(diagnosticReport(events), null, 2));
      return;
    }
    const manager = new WorktreeManager();
    const sourceAgents = structuredClone(config.agents);
    config = resolveAgentSettings(config, journal.latestAgentSettings(config.projectId));
    if (executing && config.agents.some((agent) => agent.transport && agent.transport !== "exec")) {
      throw new Error("Etkileşimli izin kararları için bu config'i masaüstü uygulamasında açın; CLI yalnızca exec transport çalıştırır");
    }
    const engine = new Orchestrator(journal, manager);
    if (streaming) engine.subscribe((notice) => {
      console.log(JSON.stringify(notice));
    });
    for (const agent of config.agents) {
      engine.registerAgent(configuredAdapter(agent));
    }
    let existing;
    try { existing = engine.snapshot(config.projectId, false); }
    catch {
      if (!executing) throw new Error(needsDesktop ? "Önce bu projeyi masaüstü uygulamasında açın" : "Önce --execute ile projeyi oluşturmalısınız");
      engine.createProject({ id: config.projectId, workspaceRoot: repoPath });
    }
    existing = engine.snapshot(config.projectId, false);
    if (realpathSync(existing.project.workspaceRoot).toLowerCase() !== repoPath.toLowerCase()) {
      throw new Error("Proje kimliği başka depo ile eşleşiyor");
    }
    if (checkpointing) {
      console.log(JSON.stringify({ checkpointed: true, ...engine.checkpoint() }, null, 2));
      return;
    }
    if (compacting) {
      engine.checkpoint();
      console.log(JSON.stringify(journal.compact(archiveArg!), null, 2));
      return;
    }
    if (executing) {
      const reserved = journal.reservedTaskIds(config.projectId);
      for (const task of reconcileTasks(config, existing.tasks, reserved)) engine.addTask(task);
      engine.configureAgents(config.projectId, config.agents, sourceAgents);
    }
    if (contextReview) {
      const { context, contextHistory, contextConflicts } = engine.snapshot(config.projectId);
      console.log(JSON.stringify({ context, contextHistory, contextConflicts }, null, 2));
      return;
    }
    if (resolvingContext) {
      const id = args[args.indexOf("--resolve-context") + 1];
      const revision = Number(args[args.indexOf("--revision") + 1]);
      const choice = args[args.indexOf("--choice") + 1];
      if (!id || id.startsWith("--") || !args.includes("--revision") || !args.includes("--choice")
        || !Number.isInteger(revision) || !["keep", "accept", "custom"].includes(choice ?? "")) throw new Error("--resolve-context ID --revision N --choice keep|accept|custom gerekli");
      let value: string | undefined;
      if (choice === "custom") {
        const file = args[args.indexOf("--value-file") + 1];
        if (!args.includes("--value-file") || !file || file.startsWith("--") || statSync(file).size > 65536) throw new Error("Özel karar için en fazla 64 KiB UTF-8 --value-file gerekli");
        value = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
      }
      engine.resolveContext(config.projectId, id, revision, choice as "keep" | "accept" | "custom", value);
      console.log(JSON.stringify({ resolved: id, instruction: "Karar kaydedildi; yeni görevler için ayrıca --execute kullanın." }, null, 2));
      return;
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
        ? manager.inspectTask(repoPath, task.worktree, task.allowedPaths)
        : undefined;
      return {
        id: task.id, agentId: task.agentId, status: task.status,
        summary: task.summary, error: task.error, sessionId: task.sessionId,
        tests: task.tests,
        contextPackages: task.contextPackages,
        mergeConflict: task.mergeConflict,
        testsStale: !!task.tests?.length && !!changes && task.testDigest !== changes.digest,
        worktree: task.worktree,
        reviewDigest: task.review?.digest,
        changedPaths: changes?.changedPaths,
        violations: changes?.violations,
        ...(reviewing ? { trackedDiff: changes?.trackedDiff, untrackedPreviews: changes?.untrackedPreviews } : {}),
      };
    });
    const pendingContextDecisions = snapshot.contextConflicts.filter((conflict) => conflict.status === "pending").map(({ id, key }) => ({ id, key }));
    console.log(JSON.stringify({ dbPath, mode: reviewing ? "review" : "execute", reports, pendingContextDecisions }, null, streaming ? 0 : 2));
    if (reports.some((task) => task.status === "cancelled")) process.exitCode = 130;
    else if (reports.some((task) => task.status === "failed" || task.status === "blocked" || task.status === "needs_review")) process.exitCode = 1;
    else if (pendingContextDecisions.length) process.exitCode = 2;
  } finally { journal.close(); }
}

main().catch((error: unknown) => {
  console.error(safeLog(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
