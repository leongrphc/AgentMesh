import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadlessCliAdapter, type HeadlessProvider } from "../src/adapters/headless-cli.js";
import { runJsonlProcess } from "../src/adapters/cli-process.js";
import type { AgentExecution } from "../src/core/contracts.js";
import { validate } from "../src/core/config.js";
import { configuredAdapter } from "../src/adapters/registry.js";

const input = (): AgentExecution => ({ workspaceRoot: process.cwd(), context: {}, inbox: [],
  task: { id: "t", projectId: "p", agentId: "a", title: "Test", instruction: "Implement feature", dependsOn: [], allowedPaths: ["src/**"] } });
function result(provider: HeadlessProvider, patch: Record<string, unknown> = {}) {
  return provider === "antigravity" ? { event: "result", result: { conversation_id: "session-1", status: "SUCCESS", response: "Ready", ...patch } }
    : { type: "result", session_id: "session-1", subtype: "success", is_error: false, result: "Ready", ...patch };
}
function init(provider: HeadlessProvider) {
  return provider === "antigravity" ? { event: "init", conversation_id: "session-1" } : { type: "system", subtype: "init", session_id: "session-1" };
}

test("Antigravity and Claude build native headless requests with context, exact resume and no permission bypass", async () => {
  for (const provider of ["antigravity", "claude"] as const) {
    const execution = { ...input(), sessionId: "session-1", context: { shared: { key: "shared", value: "previous-agent-result", sourceTaskId: "prior", updatedAt: new Date().toISOString() } } };
    const adapter = new HeadlessCliAdapter("a", provider, { model: "test-model", runner: async (spec) => {
      assert.equal(spec.cwd, execution.workspaceRoot);
      assert.ok(!spec.args.some((arg) => arg.includes("skip-permissions")));
      if (provider === "claude") {
        // Uses Claude Code's own authentication, but never the user's hooks, settings or MCP servers.
        assert.ok(!spec.args.includes("--bare"));
        assert.equal(spec.args[spec.args.indexOf("--setting-sources") + 1], "project");
        assert.ok(spec.args.includes("--strict-mcp-config"));
        assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
      }
      assert.equal(spec.args[spec.args.indexOf(provider === "antigravity" ? "--conversation" : "--resume") + 1], "session-1");
      const message = JSON.parse(spec.stdin!);
      const prompt = provider === "antigravity" ? message.message.content : message.message.content;
      assert.match(prompt, /previous-agent-result/); assert.match(prompt, /Implement feature/);
      assert.ok(spec.args.includes("test-model"));
      return { events: [init(provider), result(provider)], stderr: "" };
    } });
    assert.deepEqual(await adapter.execute(execution), { summary: "Ready", sessionId: "session-1" });
    const config = { projectId: "p", repoPath: ".", agents: [{ id: "a", provider }], tasks: [execution.task] };
    validate(config); assert.equal(configuredAdapter(config.agents[0]!).provider, provider);
    assert.throws(() => validate({ ...config, agents: [{ id: "a", provider, transport: "server" }] }), /Geçersiz/);
  }
});

test("Antigravity uses native file tools without granting shell permissions", async () => {
  for (const conversationOnly of [false, true]) {
    const adapter = new HeadlessCliAdapter("a", "antigravity", { conversationOnly, runner: async (spec) => {
      assert.equal(spec.args[spec.args.indexOf("--mode") + 1], conversationOnly ? "plan" : "accept-edits");
      assert.ok(spec.args.includes("--sandbox"));
      assert.deepEqual(JSON.parse(spec.args[spec.args.indexOf("--settings") + 1]!), {
        permissions: { deny: ["command(*)"] },
      });
      assert.match(JSON.parse(spec.stdin!).message.content, /Do not call RunCommand/);
      assert.match(JSON.parse(spec.stdin!).message.content, /tests as not_run/);
      return { events: [init("antigravity"), result("antigravity")], stderr: "" };
    } });
    await adapter.execute(input());
  }
});

test("Antigravity empty results preserve masked headless permission diagnostics", async () => {
  const adapter = new HeadlessCliAdapter("a", "antigravity", { runner: async () => ({
    events: [init("antigravity"), result("antigravity", { response: "" })],
    stderr: 'jetski: no output produced — a tool required the "command" permission for user@example.com; auto-denied.',
  }) });
  await assert.rejects(adapter.execute(input()), (error: Error) => {
    assert.match(error.message, /headless araç izni reddedildi/);
    assert.match(error.message, /command/);
    assert.ok(!error.message.includes("user@example.com"));
    return true;
  });
});

test("headless adapters reject nonterminal, duplicate, failed and mismatched results", async () => {
  for (const provider of ["antigravity", "claude"] as const) {
    for (const events of [[], [result(provider), result(provider)], [init(provider), result(provider, provider === "antigravity" ? { conversation_id: "foreign" } : { session_id: "foreign" })],
      [result(provider, provider === "antigravity" ? { status: "WAITING" } : { subtype: "error_max_turns", is_error: true })],
      [result(provider, provider === "antigravity" ? { response: "" } : { result: "" })]]) {
      await assert.rejects(new HeadlessCliAdapter("a", provider, { runner: async () => ({ events, stderr: "" }) }).execute(input()));
    }
    await assert.rejects(new HeadlessCliAdapter("a", provider).execute({ ...input(), sessionId: "../../foreign" }), /oturum/);
  }
});

test("native session is delivered before a real child reports failure", async () => {
  let saved = "";
  const script = `console.log(JSON.stringify({event:'init',conversation_id:'early-session'}));setTimeout(()=>{console.log(JSON.stringify({event:'result',result:{conversation_id:'early-session',status:'ERROR',error:'tool blocked'}}));},30);`;
  const adapter = new HeadlessCliAdapter("a", "antigravity", { runner: (spec) => runJsonlProcess({ ...spec, executable: process.execPath, args: ["-e", script] }) });
  await assert.rejects(adapter.execute({ ...input(), onSession: (id) => { saved = id; } }), /tool blocked/);
  assert.equal(saved, "early-session");
});

test("session notification is emitted once across streaming, replay and terminal result", async () => {
  for (const provider of ["antigravity", "claude"] as const) {
    for (const terminalOnly of [false, true]) {
      const sessions: string[] = [];
      const adapter = new HeadlessCliAdapter("a", provider, { runner: async (spec) => {
        const events = terminalOnly ? [result(provider)] : [init(provider), init(provider), result(provider)];
        for (const event of events) spec.onEvent?.(event);
        if (!terminalOnly) assert.deepEqual(sessions, ["session-1"]);
        return { events, stderr: "" };
      } });
      await adapter.execute({ ...input(), onSession: (id) => sessions.push(id) });
      assert.deepEqual(sessions, ["session-1"]);
    }
  }
});

test("Claude terminal failures retain masked diagnostics for successful and failed process exits", async () => {
  for (const processFails of [false, true]) {
    for (const details of [{ result: "Tool blocked for user@example.com" },
      { result: "", errors: ["Tool blocked for user@example.com"] }]) {
      const adapter = new HeadlessCliAdapter("a", "claude", { runner: async (spec) => {
        const event = result("claude", { subtype: "error_during_execution", is_error: true, ...details });
        spec.onEvent?.(event);
        if (processFails) throw new Error("Process exited 1");
        return { events: [event], stderr: "" };
      } });
      await assert.rejects(adapter.execute(input()), (error: Error) => {
        assert.match(error.message, /Tool blocked/);
        assert.ok(!error.message.includes("user@example.com"));
        return true;
      });
    }
  }
});

test("Claude tasks are limited to their file patterns before they run", async () => {
  const { claudeTaskRules } = await import("../src/adapters/headless-cli.js");
  assert.deepEqual(claudeTaskRules(["src/**", "tests\\unit/**"]).filter((rule) => /^(Edit|Write)/.test(rule)),
    ["Edit(src/**)", "Write(src/**)", "Edit(tests/unit/**)", "Write(tests/unit/**)"]);
  assert.ok(claudeTaskRules(["**"]).includes("Edit") && claudeTaskRules(["**"]).includes("Write"));
  assert.ok(claudeTaskRules(["src/**"]).every((rule) => rule !== "Bash"), "no unrestricted shell");
  const adapter = new HeadlessCliAdapter("a", "claude", { runner: async (spec) => {
    assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.match(spec.args[spec.args.indexOf("--allowedTools") + 1]!, /Edit\(src\/\*\*\)/);
    return { events: [init("claude"), result("claude")], stderr: "" };
  } });
  await adapter.execute(input());
  const planner = new HeadlessCliAdapter("a", "claude", { conversationOnly: true, readOnlyTools: true, runner: async (spec) => {
    assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], "plan");
    assert.ok(!spec.args.includes("--allowedTools"));
    assert.equal(spec.args[spec.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    return { events: [init("claude"), result("claude")], stderr: "" };
  } });
  await planner.execute(input());
});
