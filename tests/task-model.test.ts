import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";
import { validate, reconcileTasks, type Config } from "../src/core/config.js";
import { HeadlessCliAdapter } from "../src/adapters/headless-cli.js";
import { CodexCliAdapter } from "../src/adapters/codex-cli.js";
import { OpenCodeCliAdapter } from "../src/adapters/opencode-cli.js";
import type { AgentExecution } from "../src/core/contracts.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { JsonlRpcClient } from "../src/adapters/jsonl-rpc.js";
import { OpenCodeServerAdapter, openCodeSessionRules } from "../src/adapters/opencode-server.js";
import { OpenCodeServerClient } from "../src/adapters/opencode-server-client.js";

const task = { id: "t", projectId: "p", agentId: "a", title: "Test", instruction: "Test", dependsOn: [], allowedPaths: ["src/**"] };

test("task models validate independently and config drift includes model", () => {
  const config: Config = { projectId: "p", repoPath: ".", agents: [{ id: "a", provider: "opencode" }], tasks: [{ ...task, model: "provider/model" }] };
  validate(config);
  for (const model of ["", "bad model", "x\n", "x".repeat(201), "missing-provider"]) {
    assert.throws(() => validate({ ...config, tasks: [{ ...task, model }] }), /model/i);
  }
  assert.throws(() => reconcileTasks(config, [{ ...task, model: "provider/other" }]), /model/);
  validate({ ...config, tasks: [task] });
});

test("desktop task overrides survive reopening and clear when handed to another agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-task-model-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const file = join(root, "config.json");
  const config: Config = { projectId: "p", repoPath: repo, agents: [{ id: "a", provider: "codex", model: "agent-default" }, { id: "b", provider: "antigravity" }], tasks: [] };
  writeFileSync(file, JSON.stringify(config));
  const service = new DesktopService(join(root, "demo"));
  try {
    service.openConfig(file);
    service.createTask({ ...task, model: "task-choice" });
    assert.equal(service.state().agents[0]?.model, "agent-default");
    assert.throws(() => service.createTask({ ...task, id: "bad", model: "bad model" }), /model/i);
    await service.close();
    assert.equal(service.openConfig(file).snapshot.tasks[0]?.model, "task-choice");
    service.reassignTask("t", "b");
    assert.equal(service.state().snapshot.tasks[0]?.model, undefined);
    await service.close();
    assert.equal(service.openConfig(file).snapshot.tasks[0]?.model, undefined);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("server transports prefer task model for new and resumed sessions", async () => {
  for (const resumed of [false, true]) {
    for (const override of [undefined, "provider/task-choice"]) {
      const expected = override ?? "provider/agent-default";
      const execution: AgentExecution = { workspaceRoot: process.cwd(), task: { ...task, model: override }, context: {}, inbox: [],
        ...(resumed ? { sessionId: "thread-1" } : {}) };
      const codex = new CodexAppServerAdapter("a", { model: "provider/agent-default", clientFactory: options => ({
        async request(method: string, params: Record<string, unknown>) {
          if (method === "initialize") return {};
          if (method === (resumed ? "thread/resume" : "thread/start")) {
            assert.equal(params.model, expected);
            return { thread: { id: "thread-1" } };
          }
          assert.equal(method, "turn/start");
          options.onNotification?.("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          options.onNotification?.("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "Ready" } });
          options.onNotification?.("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
          return { turn: { id: "turn-1" } };
        }, notify() {}, async close() {},
      } as unknown as JsonlRpcClient) });
      assert.equal((await codex.execute(execution)).summary, "Ready");
      const opencode = new OpenCodeServerAdapter("a", { model: "provider/agent-default", serverFactory: async () => ({
        sameDirectory: () => true,
        async request(path: string, _method?: string, body?: Record<string, unknown>) {
          if (path === "/session/status") return {};
          if (path === "/permission") return [];
          if (path.endsWith("/message")) {
            assert.deepEqual(body?.model, { providerID: "provider", modelID: expected.split("/")[1] });
            return { info: { id: "msg_result", role: "assistant", sessionID: "ses_test", parentID: body?.messageID, time: { completed: 1 }, finish: "stop" },
              parts: [{ type: "text", sessionID: "ses_test", messageID: "msg_result", text: "Ready" }] };
          }
          return { id: "ses_test", directory: process.cwd(), permission: openCodeSessionRules };
        },
        async events() { return { done: new Promise<never>(() => {}), async close() {} }; },
        async close() {},
      } as unknown as OpenCodeServerClient) });
      assert.equal((await opencode.execute({ ...execution, sessionId: resumed ? "ses_test" : undefined })).summary, "Ready");
    }
  }
});

test("CLI adapters send task model before agent default, including resumed sessions", async () => {
  for (const provider of ["claude", "antigravity", "codex", "opencode"] as const) {
    for (const override of [undefined, "provider/task-choice"]) {
      const execution: AgentExecution = { workspaceRoot: process.cwd(), task: { ...task, model: override }, context: {}, inbox: [], sessionId: "session-1" };
      const runner = async (spec: import("../src/adapters/cli-process.js").ProcessSpec) => {
        const flag = provider === "codex" ? "-m" : "--model";
        assert.equal(spec.args[spec.args.indexOf(flag) + 1], override ?? "provider/agent-default");
        return { events: provider === "claude" ? [{ type: "result", session_id: "session-1", subtype: "success", is_error: false, result: "Ready" }]
          : provider === "antigravity" ? [{ event: "result", result: { conversation_id: "session-1", status: "SUCCESS", response: "Ready" } }]
          : provider === "codex" ? [{ type: "item.completed", item: { type: "agent_message", text: "Ready" } }]
          : [{ type: "text", part: { text: "Ready" } }], stderr: "" };
      };
      const options = { model: "provider/agent-default", runner };
      const adapter = provider === "codex" ? new CodexCliAdapter("a", options) : provider === "opencode" ? new OpenCodeCliAdapter("a", options) : new HeadlessCliAdapter("a", provider, options);
      await adapter.execute(execution);
    }
  }
});
