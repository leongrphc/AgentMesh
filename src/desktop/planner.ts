import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../core/config.js";
import { orderTasks } from "../core/config.js";
import type { AgentTask } from "../core/contracts.js";
import type { TaskDraft } from "./contracts.js";

export const MAX_PLAN_TASKS = 12;
const MAX_FILES_IN_PROMPT = 400;

/** What the planner can see of the project: tracked file paths and the start of the README. */
export function projectOverview(root: string): string {
  let files: string[] = [];
  try {
    files = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean);
  } catch { /* Not fatal: the planner can still work from the goal alone. */ }
  const listed = files.slice(0, MAX_FILES_IN_PROMPT).join("\n");
  const more = files.length > MAX_FILES_IN_PROMPT ? `\n… ve ${files.length - MAX_FILES_IN_PROMPT} dosya daha` : "";
  const readmePath = ["README.md", "readme.md", "README"].map((name) => join(root, name)).find((path) => existsSync(path));
  const readme = readmePath ? readFileSync(readmePath, "utf8").slice(0, 3000) : "";
  return `Dosyalar (${files.length}):\n${listed || "(boş)"}${more}${readme ? `\n\nREADME başlangıcı:\n${readme}` : ""}`;
}

export function buildPlanPrompt(goal: string, agents: readonly AgentConfig[], overview: string, existing: readonly AgentTask[]): string {
  const agentList = agents.map((agent) => `- ${agent.id} (${agent.provider}${agent.role ? `; rol: ${agent.role}` : ""})`).join("\n");
  const existingList = existing.length ? existing.map((task) => `- ${task.id}: ${task.title}`).join("\n") : "(yok)";
  return [
    "Bir yazılım projesinde çalışan bir ajan ekibinin planlayıcısısın. Kod yazma, dosya değiştirme ya da komut çalıştırma; yalnızca plan üret.",
    `Hedef:\n${goal}`,
    `Kullanılabilir ajanlar:\n${agentList}`,
    `Projede zaten olan görevler:\n${existingList}`,
    overview,
    "Hedefi en fazla " + MAX_PLAN_TASKS + " göreve böl. Kurallar:",
    "- Her görev tek bir ajanın tek seferde bitirebileceği, incelenebilir büyüklükte olsun.",
    "- Birbirinden bağımsız işler bağımsız kalsın ki paralel çalışabilsin; gerçekten önce bitmesi gerekeni dependsOn ile belirt.",
    "- instruction ne yapılacağını, hangi dosyaların etkileneceğini ve işin ne zaman bitmiş sayılacağını anlatsın.",
    "- allowedPaths görevin değiştirebileceği dosyalar için glob desenleri olsun (ör. \"src/api/**\"); emin değilsen [\"**\"].",
    "- agentId yukarıdaki ajanlardan biri olsun; işleri ajanlar arasında dengeli dağıt.",
    "- id küçük harf, rakam ve tire içersin; dependsOn yalnızca bu plandaki ya da projede zaten olan görev kimliklerini içersin.",
    "Yanıtın yalnızca şu JSON olsun, başka metin yazma:",
    '{"tasks":[{"id":"api-endpoint","title":"…","instruction":"…","agentId":"…","dependsOn":[],"allowedPaths":["**"]}]}',
  ].join("\n\n");
}

/** First JSON object in a model reply, with or without a ```json fence. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Planlayıcı JSON bir plan döndürmedi.");
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch { throw new Error("Planlayıcının yanıtı geçerli JSON değil."); }
}

const slug = (value: string) => value.toLocaleLowerCase("tr-TR").replace(/ı/g, "i").normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

/**
 * Validates a planner reply into task drafts the user can edit before anything is created.
 * Unknown agents fall back to the first agent, ids are made unique, dependencies are limited to
 * the plan and existing tasks, and cycles are rejected.
 */
export function parsePlan(reply: string, agents: readonly AgentConfig[], existing: readonly AgentTask[]): TaskDraft[] {
  const value = extractJson(reply) as { tasks?: unknown };
  if (!value || typeof value !== "object" || !Array.isArray(value.tasks) || !value.tasks.length) throw new Error("Planda görev yok.");
  if (!agents.length) throw new Error("Projede ajan yok.");
  const taken = new Set(existing.map((task) => task.id));
  const renamed = new Map<string, string>();
  const drafts: TaskDraft[] = [];
  for (const raw of value.tasks.slice(0, MAX_PLAN_TASKS)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 200) : "";
    const instruction = typeof entry.instruction === "string" ? entry.instruction.trim().slice(0, 16000) : "";
    if (!title || !instruction) continue;
    const wanted = slug(typeof entry.id === "string" && entry.id ? entry.id : title) || "gorev";
    let id = wanted;
    for (let n = 2; taken.has(id); n++) id = `${wanted}-${n}`;
    taken.add(id);
    if (typeof entry.id === "string") renamed.set(entry.id, id);
    renamed.set(wanted, id);
    const agentId = agents.some((agent) => agent.id === entry.agentId) ? entry.agentId as string : agents[0]!.id;
    const allowedPaths = Array.isArray(entry.allowedPaths)
      ? entry.allowedPaths.filter((path): path is string => typeof path === "string" && !!path.trim()).map((path) => path.trim()).slice(0, 20) : [];
    drafts.push({ id, title, instruction, agentId, allowedPaths: allowedPaths.length ? allowedPaths : ["**"],
      dependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn.filter((dep): dep is string => typeof dep === "string") : [] });
  }
  if (!drafts.length) throw new Error("Planda başlığı ve talimatı olan görev yok.");
  const known = new Set([...existing.map((task) => task.id), ...drafts.map((draft) => draft.id)]);
  for (const draft of drafts) {
    draft.dependsOn = [...new Set(draft.dependsOn.map((dep) => renamed.get(dep) ?? dep).filter((dep) => known.has(dep) && dep !== draft.id))];
  }
  // Throws on cycles; the order also lets the caller create tasks dependencies-first.
  const ordered = orderTasks([...existing, ...drafts.map((draft) => ({ ...draft, projectId: "plan" }))]);
  const position = new Map(ordered.map((task, index) => [task.id, index]));
  return drafts.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
}
