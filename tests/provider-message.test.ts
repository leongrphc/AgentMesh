import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { sendProviderMessage } from "../src/adapters/provider-message.js";
import { runJsonlProcess } from "../src/adapters/cli-process.js";

test("message test isolates cwd, projects bounded output and cleans up on success or cancellation", async () => {
  let directory = "";
  const result = await sendProviderMessage({ provider: "codex", message: "Selam" }, undefined, {
    codex: async (input, cwd) => { directory = cwd; assert.equal(input.message, "Selam"); assert.ok(existsSync(cwd)); assert.notEqual(cwd, process.cwd()); return "Selam! " + "x".repeat(10000); },
  });
  assert.ok(result.response.length < 9000);
  assert.equal(existsSync(directory), false);
  const abort = new AbortController();
  await assert.rejects(sendProviderMessage({ provider: "codex", message: "Selam" }, abort.signal, {
    codex: async (_input, cwd, signal) => { directory = cwd; abort.abort(); signal.throwIfAborted(); return ""; },
  }), /iptal/);
  assert.equal(existsSync(directory), false);
  for (const input of [{ provider: "other", message: "Hi" }, { provider: "codex", message: "" }, { provider: "codex", message: "x".repeat(2001) }, { provider: "opencode", message: "Hi", model: "invalid" }]) {
    await assert.rejects(sendProviderMessage(input as never));
  }
});

test("OpenCode message uses deny-all session, validates answer scope and deletes owned sessions", async () => {
  for (const mode of ["ok", "wrong-parent", "bad-policy", "api-error"]) {
    let closed = false, deleted = false, prompted = false, directory = "";
    const request = sendProviderMessage({ provider: "opencode", transport: "server", model: "test/model", message: "Selam" }, undefined, {
      openCode: async (cwd) => { directory = cwd; return {
        close: async () => { closed = true; },
        request: async (path, method, body) => {
          if (method === "DELETE") { assert.equal(path, "/session/ses_test"); deleted = true; return true; }
          const data = body as Record<string, unknown>;
          if (path === "/session") {
            assert.deepEqual(data.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
            return { id: "ses_test", permission: mode === "bad-policy" ? [] : data.permission };
          }
          assert.equal(path, "/session/ses_test/message"); prompted = true;
          assert.deepEqual(data.model, { providerID: "test", modelID: "model" });
          if (mode === "api-error") return { info: { error: { data: { message: "Provider unavailable", responseHeaders: { private: "do not expose headers" } } } } };
          return { info: { id: "answer", role: "assistant", sessionID: "ses_test", parentID: mode === "wrong-parent" ? "foreign" : data.messageID, finish: "stop", time: { completed: Date.now() } },
            parts: [{ type: "text", sessionID: "ses_test", messageID: "answer", text: "Selam!" }, { type: "text", sessionID: "foreign", messageID: "answer", text: "foreign answer" }] };
        },
      }; },
    });
    if (mode === "ok") assert.equal((await request).response, "Selam!");
    else await assert.rejects(request, mode === "bad-policy" ? /politika/ : mode === "api-error" ? /Provider unavailable/ : /tamamlanmış/);
    assert.equal(closed, true); assert.equal(deleted, true);
    assert.equal(prompted, mode !== "bad-policy"); assert.equal(existsSync(directory), false);
  }
});

test("OpenCode CLI messages use native run, explicit deny agent, positional prompt and complete JSON events", async () => {
  for (const mode of ["ok", "error", "incomplete"]) {
    const pending = sendProviderMessage({ provider: "opencode", transport: "exec", model: "opencode/space-bunny-free", message: "--not-a-flag" }, undefined, {
      cliRunner: async (spec) => {
        assert.equal(spec.args[0], "run");
        assert.deepEqual(spec.args.slice(-2), ["--", "--not-a-flag"]);
        assert.ok(spec.args.includes("opencode/space-bunny-free"));
        const config = JSON.parse(spec.env!.OPENCODE_CONFIG_CONTENT!);
        assert.deepEqual(config.permission, { "*": "deny" });
        assert.deepEqual(config.agent["agentmesh-message-test"].permission, { "*": "deny" });
        if (mode === "error") return { events: [{ type: "error", error: { data: { message: "Free tier denied" } } }], stderr: "" };
        return { events: [{ type: "text", part: { text: "Selam!" } }, ...(mode === "ok" ? [{ type: "step_finish", part: { reason: "stop" } }] : [])], stderr: "" };
      },
    });
    if (mode === "ok") { const result = await pending; assert.equal(result.response, "Selam!"); assert.equal(result.transport, "exec"); }
    else await assert.rejects(pending, mode === "error" ? /Free tier denied/ : /tamamlanmış/);
  }
});

test("CLI failures expose the JSON error message without leaking provider headers", async () => {
  await assert.rejects(runJsonlProcess({ executable: process.execPath, cwd: process.cwd(),
    env: { ...process.env, AGENTMESH_PROCESS_CHECK: "visible failure" },
    args: ["-e", `console.log(JSON.stringify({type:'error',error:{data:{message:process.env.AGENTMESH_PROCESS_CHECK,responseHeaders:{secret:'do-not-expose'}}}}));process.exitCode=1;`],
  }), (error: Error) => error.message.includes("visible failure") && !error.message.includes("do-not-expose"));
});
