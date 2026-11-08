import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Journal } from "../src/core/journal.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { WorktreeManager } from "../src/core/worktrees.js";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CopilotClientOptions, SessionConfig, SessionEvent, SessionMetadata, PermissionRequest } from "@github/copilot-sdk";
import { CopilotSdkAdapter, copilotClientOptions, type CopilotClientHandle, type CopilotFactory, type CopilotSessionHandle } from "../src/adapters/copilot-sdk.js";
import type { AgentExecution } from "../src/core/contracts.js";
import { validate, type Config } from "../src/core/config.js";
import { configuredAdapter } from "../src/adapters/registry.js";
import { probeCopilot } from "../src/adapters/provider-health.js";
import { sendProviderMessage, validateProviderMessage } from "../src/adapters/provider-message.js";

const id = "copilot-session";
const answer = (content = "Done") => ({ type: "assistant.message", id: "event", timestamp: new Date().toISOString(), parentId: null,
  data: { messageId: "message", content } }) as SessionEvent & { type: "assistant.message" };

function fake(run?: (config: SessionConfig, emit: (event: SessionEvent) => void) => Promise<ReturnType<typeof answer> | undefined>) {
  let config!: SessionConfig, options!: CopilotClientOptions;
  let listener = (_event: SessionEvent) => {};
  const calls: string[] = [], prompts: unknown[] = [];
  let metadata: SessionMetadata[] = [], authenticated = true;
  const session: CopilotSessionHandle = {
    sessionId: id,
    on: ((handler: (event: SessionEvent) => void) => { listener = handler; return () => { calls.push("unsubscribe"); }; }) as CopilotSessionHandle["on"],
    sendAndWait: (async (input: unknown) => { calls.push("send"); prompts.push(input); return run ? run(config, (event) => listener(event)) : answer(); }) as CopilotSessionHandle["sendAndWait"],
    async abort() { calls.push("abort"); }, async disconnect() { calls.push("disconnect"); },
  };
  const client: CopilotClientHandle = {
    async start() { calls.push("start"); }, async stop() { calls.push("stop"); return []; }, async forceStop() { calls.push("forceStop"); },
    async createSession(value) { calls.push("create"); config = value; return { ...session, sessionId: value.sessionId! }; },
    async resumeSession(_id, value) { calls.push("resume"); config = value; return session; },
    async listSessions() { calls.push("list"); return metadata; },
    async getAuthStatus() { calls.push("auth"); return { isAuthenticated: authenticated }; },
    async getStatus() { calls.push("status"); return { version: "1.0.107" }; },
  };
  const factory: CopilotFactory = (value) => { options = value; return client; };
  return { factory, calls, prompts, client, get config() { return config; }, get options() { return options; },
    set metadata(value: SessionMetadata[]) { metadata = value; }, set authenticated(value: boolean) { authenticated = value; } };
}
async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "agentmesh-copilot-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "private"));
  await writeFile(join(directory, "src", "file.ts"), "original");
  await writeFile(join(directory, "private", "secret.ts"), "private");
  return realpath(directory);
}
function input(root: string): AgentExecution {
  return { workspaceRoot: root, context: {}, inbox: [], task: { id: "task", projectId: "project", agentId: "copilot", title: "Implement",
    instruction: "Implement the task", dependsOn: [], allowedPaths: ["src/**"] } };
}
const invoke = async (config: SessionConfig, request: Record<string, unknown>) => config.onPermissionRequest!(request as unknown as PermissionRequest, { sessionId: config.sessionId! });
const read = (path: string, toolCallId = "read-call") => ({ kind: "read", path, intention: "Read file", toolCallId });
const write = (fileName: string, toolCallId = "write-call") => ({ kind: "write", fileName, diff: "+change", intention: "Edit file", canOfferSessionApproval: false, toolCallId });

test("Copilot configuration and registry use the official native SDK, not generic OpenCode fallback", () => {
  const config: Config = { projectId: "p", repoPath: ".", agents: [{ id: "copilot", provider: "copilot", model: "gpt-5.4" }], tasks: [] };
  validate(config);
  const adapter = configuredAdapter(config.agents[0]!);
  assert.ok(adapter instanceof CopilotSdkAdapter);
  assert.equal(adapter.interactivePermissions, true);
  assert.equal(adapter.connection, "cli");
  assert.throws(() => validate({ ...config, agents: [{ ...config.agents[0]!, transport: "server" }] }), /ajan/);
  assert.throws(() => validate({ ...config, agents: [{ ...config.agents[0]!, model: "invalid model" }] }), /model/);
  const options = copilotClientOptions("C:/repo");
  assert.equal(options.connection?.kind, "stdio");
  assert.equal(options.mode, "empty");
  assert.equal(options.useLoggedInUser, true);
  assert.equal(options.gitHubToken, undefined);
  assert.ok(options.baseDirectory);
});

test("Copilot task model overrides agent default; streaming and session ID are retained", async (t) => {
  const root = await workspace(t);
  for (const [taskModel, expected] of [["task-model", "task-model"], [undefined, "agent-model"]]) {
    const native = fake(async (_config, emit) => { emit(answer("Streamed")); return answer(); });
    const execution = input(root); execution.task.model = taskModel;
    const sessions: string[] = [], outputs: unknown[] = [];
    execution.onSession = (session) => { sessions.push(session); }; execution.onOutput = (output) => { outputs.push(output); };
    const result = await new CopilotSdkAdapter("copilot", { model: "agent-model", clientFactory: native.factory }).execute(execution);
    assert.equal(native.config.model, expected);
    assert.equal(native.options.workingDirectory, root);
    assert.equal(native.config.workingDirectory, root);
    assert.equal(native.config.streaming, true);
    assert.deepEqual(native.config.availableTools, ["builtin:view", "builtin:glob", "builtin:grep", "builtin:edit", "builtin:create"]);
    assert.equal(native.config.enableConfigDiscovery, false); assert.equal(native.config.enableFileHooks, false);
    assert.equal(native.config.enableSkills, false); assert.deepEqual(native.config.mcpServers, {});
    assert.equal(result.summary, "Done"); assert.equal(result.sessionId, sessions[0]);
    assert.equal(outputs.length, 1); assert.ok(JSON.stringify(native.prompts).includes("Implement the task"));
    assert.equal(native.calls.at(-1), "stop"); assert.ok(!native.calls.includes("abort"));
  }
});

test("Copilot permissions default deny, unknown/shell/network kinds never reach the broker", async (t) => {
  const root = await workspace(t);
  const native = fake(async (config) => {
    for (const request of [read("src/file.ts"), write("src/file.ts"), { kind: "shell", fullCommandText: "npm test" },
      { kind: "url", url: "https://example.com" }, { kind: "mcp", toolName: "remote" }, { kind: "unknown" }]) {
      assert.equal((await invoke(config, request)).kind, "reject");
    }
    return answer();
  });
  await new CopilotSdkAdapter("copilot", { clientFactory: native.factory }).execute(input(root));
});

test("Copilot grants only one human-approved scoped request; duplicate and foreign sessions deny", async (t) => {
  const root = await workspace(t); let asked = 0;
  const native = fake(async (config) => {
    assert.equal((await invoke(config, write("src/file.ts"))).kind, "approve-once");
    assert.equal((await invoke(config, write("src/file.ts"))).kind, "reject");
    assert.equal((await invoke(config, read("src/file.ts"))).kind, "approve-once");
    assert.equal((await config.onPermissionRequest!(read("src/file.ts") as PermissionRequest, { sessionId: "foreign" })).kind, "reject");
    for (const request of [write("private/secret.ts"), write("../escape.ts"), write("src/../../escape.ts"),
      read("https://example.com"), read("../escape"), write("src/*.ts"), write(".git/config"),
      { ...write("src/file.ts"), resolvedPath: join(root, "private", "secret.ts") },
      { ...write("src/new.ts"), fileEdits: [{ before: { path: join(root, "private", "secret.ts"), content: "private" }, after: { path: join(root, "src", "new.ts"), content: "new" } }] },
      { ...write("src/new.ts"), requestSandboxBypass: true }]) assert.equal((await invoke(config, request)).kind, "reject");
    return answer();
  });
  const execution = input(root);
  execution.requestPermission = async (proposal) => { asked++; assert.equal(proposal.provider, "copilot"); assert.equal(proposal.kind, "file"); return "allow_once"; };
  await new CopilotSdkAdapter("copilot", { clientFactory: native.factory }).execute(execution);
  assert.equal(asked, 2);
});

test("Copilot canonical scope rejects symlink escapes, aliases outside allowedPaths and changed links", async (t) => {
  const root = await workspace(t); const outside = await mkdtemp(join(tmpdir(), "copilot-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "src", "outside"), "junction");
  await symlink(join(root, "private"), join(root, "src", "alias"), "junction");
  const link = join(root, "src", "change"); await mkdir(join(root, "src", "target"));
  await symlink(join(root, "src", "target"), link, "junction");
  const native = fake(async (config) => {
    for (const request of [write("src/outside/new.ts"), read("src/outside/secret"), write("src/alias/secret.ts")]) assert.equal((await invoke(config, request)).kind, "reject");
    assert.equal((await invoke(config, write("src/change/new.ts"))).kind, "reject");
    return answer();
  });
  const execution = input(root); let asked = 0;
  execution.requestPermission = async () => { asked++; await rm(link); await symlink(outside, link, "junction"); return "allow_once"; };
  await new CopilotSdkAdapter("copilot", { clientFactory: native.factory }).execute(execution);
  assert.equal(asked, 1);
});

test("Copilot pre-tool hook forces ask, blocks out-of-scope writes, shell and glob traversal", async (t) => {
  const root = await workspace(t);
  const native = fake(async (config) => {
    const hook = (toolName: string, toolArgs: unknown, extra = {}) => config.hooks!.onPreToolUse!({ toolName, toolArgs, workingDirectory: root,
      sessionId: config.sessionId!, timestamp: new Date(), ...extra }, { sessionId: config.sessionId! });
    assert.equal((await hook("edit", { path: "src/file.ts" }))?.permissionDecision, "ask");
    assert.equal((await hook("view", { path: "src/file.ts" }))?.permissionDecision, "ask");
    assert.equal((await hook("edit", { path: "private/secret.ts" }))?.permissionDecision, "deny");
    assert.equal((await hook("bash", { command: "pwd" }))?.permissionDecision, "deny");
    assert.equal((await hook("view", { path: "src/file.ts" }, { agentId: "subagent" }))?.permissionDecision, "deny");
    assert.equal((await hook("glob", { pattern: "../**" }))?.permissionDecision, "deny");
    assert.equal((await hook("glob", { pattern: "src/**" }))?.permissionDecision, "ask");
    return answer();
  });
  await new CopilotSdkAdapter("copilot", { clientFactory: native.factory }).execute(input(root));
});

test("Copilot resume verifies native working directory before attaching and reapplies model/policy", async (t) => {
  const root = await workspace(t); const execution = { ...input(root), sessionId: id };
  const native = fake(); native.metadata = [{ sessionId: id, context: { workingDirectory: root }, isRemote: false, startTime: new Date(), modifiedTime: new Date() }];
  await new CopilotSdkAdapter("copilot", { model: "chosen", clientFactory: native.factory }).execute(execution);
  assert.ok(native.calls.includes("resume")); assert.ok(!native.calls.includes("create")); assert.equal(native.config.model, "chosen");
  for (const metadata of [[], [{ sessionId: id, context: { workingDirectory: tmpdir() }, isRemote: false, startTime: new Date(), modifiedTime: new Date() }],
    [{ sessionId: id, context: { workingDirectory: root }, isRemote: true, startTime: new Date(), modifiedTime: new Date() }]]) {
    const other = fake(); other.metadata = metadata;
    await assert.rejects(new CopilotSdkAdapter("copilot", { clientFactory: other.factory }).execute(execution), /çalışma alanına/);
    assert.ok(!other.calls.includes("resume")); assert.equal(other.calls.at(-1), "stop");
  }
});

test("Copilot native errors, empty answers and transport failures abort and clean up", async (t) => {
  const root = await workspace(t);
  for (const run of [async () => answer(""), async () => undefined, async () => { throw new Error("transport closed"); },
    async (_config: SessionConfig, emit: (event: SessionEvent) => void) => { emit({ type: "session.error", data: { message: "provider failed" } } as SessionEvent); return answer(); }]) {
    const native = fake(run);
    await assert.rejects(new CopilotSdkAdapter("copilot", { clientFactory: native.factory }).execute(input(root)));
    assert.ok(native.calls.includes("abort")); assert.equal(native.calls.at(-1), "stop");
  }
});

test("Copilot cancellation rejects promptly and invalidates a pending human permission", async (t) => {
  const root = await workspace(t), abort = new AbortController();
  let pending!: Promise<unknown>;
  const native = fake(async (config) => { pending = invoke(config, write("src/file.ts")); return new Promise(() => {}); });
  const execution = input(root); execution.signal = abort.signal;
  execution.requestPermission = async (_proposal, signal) => { queueMicrotask(() => abort.abort()); return new Promise((resolve) => signal!.addEventListener("abort", () => resolve("allow_once"), { once: true })); };
  await assert.rejects(new CopilotSdkAdapter("copilot", { clientFactory: native.factory }).execute(execution), /iptal/);
  assert.equal((await pending as { kind: string }).kind, "reject");
  assert.ok(native.calls.includes("abort")); assert.equal(native.calls.at(-1), "stop");
});

test("Copilot conversation has zero tools; planner has scoped read-only tools, no commands", async (t) => {
  const root = await workspace(t);
  for (const readOnlyTools of [false, true]) {
    const native = fake(async (config) => {
      assert.equal((await invoke(config, write("src/file.ts"))).kind, "reject");
      assert.equal((await invoke(config, read("src/file.ts"))).kind, readOnlyTools ? "approve-once" : "reject");
      assert.equal((await invoke(config, read("../outside"))).kind, "reject");
      assert.equal((await invoke(config, { ...read("src/file.ts"), managedApprovalRequired: true })).kind, "reject");
      return answer("Plan");
    });
    await new CopilotSdkAdapter("copilot", { conversationOnly: true, readOnlyTools, clientFactory: native.factory }).execute(input(root));
    assert.deepEqual(native.config.availableTools, readOnlyTools ? ["builtin:view", "builtin:glob", "builtin:grep"] : []);
    assert.equal((native.prompts[0] as { prompt: string }).prompt, "Implement the task");
  }
});

test("Copilot integrates with worktree, human permission broker and exact review without native model calls", async (t) => {
  const root = await workspace(t);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Copilot Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, ".gitignore"), "events.jsonl\n");
  git("add", "."); git("commit", "-m", "initial");
  const journal = new Journal(join(root, "events.jsonl"));
  const engine = new Orchestrator(journal, new WorktreeManager());
  engine.createProject({ id: "project", workspaceRoot: root });
  let usedRoot = "";
  const native = fake(async (config) => {
    usedRoot = config.workingDirectory!;
    assert.notEqual(usedRoot, root);
    assert.equal((await invoke(config, write("src/feature.ts"))).kind, "approve-once");
    await writeFile(join(usedRoot, "src", "feature.ts"), "export const feature = true;\n");
    return answer(JSON.stringify({ agentmeshVersion: 1, summary: "Feature ready", facts: [{ key: "feature", value: "ready" }], messages: [] }));
  });
  engine.registerAgent(new CopilotSdkAdapter("copilot", { clientFactory: native.factory }));
  engine.subscribe(() => {
    for (const permission of engine.pendingPermissions("project")) engine.decidePermission("project", permission.id, permission.executionId, permission.digest, "allow_once");
  });
  engine.addTask(input(root).task);
  const state = await engine.run("project");
  const task = state.tasks[0]!;
  assert.equal(task.status, "pending_review", task.error); assert.equal(task.sessionId, native.config.sessionId);
  assert.equal(task.worktree?.path, usedRoot); assert.equal(state.context.feature, undefined);
  assert.throws(() => engine.approveTask(task.id, "wrong-digest"), /inceleme|digest|değiş/i);
  engine.approveTask(task.id, task.review!.digest);
  assert.equal(engine.snapshot("project").context.feature?.value, "ready");
  assert.equal(engine.snapshot("project").tasks[0]!.status, "completed");
});

test("Copilot health reads auth metadata only; independent message requires explicit send", async () => {
  const native = fake();
  const result = await probeCopilot(tmpdir(), undefined, native.factory);
  assert.equal(result.status, "configured"); assert.deepEqual(native.calls, ["start", "status", "auth", "stop"]);
  native.authenticated = false;
  assert.equal((await probeCopilot(tmpdir(), undefined, native.factory)).status, "needs_login");
  const message = fake();
  validateProviderMessage({ provider: "copilot", message: "Hello" });
  const response = await sendProviderMessage({ provider: "copilot", message: "Hello", model: "test-model" }, undefined, { copilot: message.factory });
  assert.equal(response.provider, "copilot"); assert.equal(response.response, "Done"); assert.equal(message.config.model, "test-model");
  assert.deepEqual(message.config.availableTools, []);
  await assert.rejects(realpath(message.options.workingDirectory!));
});
