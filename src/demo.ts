import { resolve } from "node:path";
import { SqliteJournal } from "./core/sqlite-journal.js";
import { Orchestrator } from "./core/orchestrator.js";
import { MockAgent } from "./adapters/mock.js";
import type { AgentTask } from "./core/contracts.js";

const projectId = "demo-store";
const root = resolve(".");
const journal = new SqliteJournal(
  resolve(root, ".agentmesh", "demo.sqlite"),
  resolve(root, ".agentmesh", "demo-events.jsonl"),
);
const engine = new Orchestrator(journal);

engine.registerAgent(new MockAgent("architect", async () => ({
  summary: "Kimlik doğrulama mimarisi belirlendi.",
  facts: [{ key: "auth.contract", value: "POST /api/login -> {token:string}" }],
  messages: [{ to: "*", kind: "handoff", body: "Auth sözleşmesi ortak context'e eklendi." }],
})));
engine.registerAgent(new MockAgent("backend", async ({ context }) => ({
  summary: `API tarafı hazır: ${context["auth.contract"]?.value}`,
  facts: [{ key: "backend.status", value: "hazır" }],
  messages: [{ to: "reviewer", kind: "handoff", body: "Backend incelemeye hazır." }],
})));
engine.registerAgent(new MockAgent("frontend", async ({ context }) => ({
  summary: `Form tarafı hazır: ${context["auth.contract"]?.value}`,
  facts: [{ key: "frontend.status", value: "hazır" }],
  messages: [{ to: "reviewer", kind: "handoff", body: "Frontend incelemeye hazır." }],
})));
engine.registerAgent(new MockAgent("reviewer", async ({ context, inbox }) => ({
  summary: `Kontrol edildi: backend=${context["backend.status"]?.value}, frontend=${context["frontend.status"]?.value}, mesaj=${inbox.length}`,
})));

function task(id: string, agentId: string, dependsOn: string[]): AgentTask {
  return {
    id, projectId, agentId, dependsOn,
    title: id,
    instruction: `${id} aşamasını uygula`,
    allowedPaths: [],
  };
}

let state;
try {
  state = engine.snapshot(projectId);
} catch {
  engine.createProject({ id: projectId, workspaceRoot: root });
  engine.addTask(task("plan", "architect", []));
  engine.addTask(task("backend", "backend", ["plan"]));
  engine.addTask(task("frontend", "frontend", ["plan"]));
  engine.addTask(task("review", "reviewer", ["backend", "frontend"]));
}

state = await engine.run(projectId, 2);
console.log(JSON.stringify({
  tasks: state.tasks.map(({ id, agentId, status, summary }) => ({ id, agentId, status, summary })),
  context: state.context,
  messages: state.messages,
}, null, 2));
journal.close();
