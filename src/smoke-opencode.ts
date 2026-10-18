import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { OpenCodeServerClient } from "./adapters/opencode-server-client.js";
import { openCodeSessionRules, hasOpenCodeSessionPolicy } from "./adapters/opencode-server.js";
import { record } from "./adapters/jsonl-rpc.js";

/** Validates real local protocol/session operations without sending a prompt or model request. */
async function main() {
  const root = mkdtempSync(join(tmpdir(), "agentmesh-opencode-smoke-"));
  let server: OpenCodeServerClient | undefined;
  let sessionId: string | undefined;
  let stream: Awaited<ReturnType<OpenCodeServerClient["events"]>> | undefined;
  try {
    server = await OpenCodeServerClient.start({ cwd: root, timeoutMs: 30000 });
    const session = record(await server.request("/session", "POST", { title: "AgentMesh protocol smoke (no model)", permission: openCodeSessionRules }));
    assert.equal(typeof session.id, "string");
    assert.match(session.id as string, /^ses[\w-]{1,200}$/);
    sessionId = session.id as string;
    assert.ok(hasOpenCodeSessionPolicy(session.permission));
    assert.ok(server.sameDirectory(session.directory as string));
    const reopened = record(await server.request(`/session/${encodeURIComponent(sessionId)}`));
    assert.equal(reopened.id, sessionId);
    assert.ok(server.sameDirectory(reopened.directory as string));
    const updated = record(await server.request(`/session/${encodeURIComponent(sessionId)}`, "PATCH", { permission: openCodeSessionRules }));
    assert.ok(hasOpenCodeSessionPolicy(updated.permission));
    assert.equal(updated.id, sessionId);
    const pending = await server.request("/permission");
    assert.ok(Array.isArray(pending));
    assert.ok(!pending.some((entry) => record(entry).sessionID === sessionId));
    let connected!: () => void;
    const connectedEvent = new Promise<void>((done) => { connected = done; });
    stream = await server.events((event) => { if (event.type === "server.connected") connected(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([connectedEvent, stream.done, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("SSE connection timeout")), 5000); })]); }
    finally { clearTimeout(timer); }
    console.log(JSON.stringify({ ok: true, version: server.version, authentication: "required", schema: "validated",
      sessionPolicy: "create-read-update-validated", sse: "connected", modelCalls: 0 }, null, 2));
  } finally {
    try {
      await stream?.close();
      if (server && sessionId) {
        const deleted = await server.request(`/session/${encodeURIComponent(sessionId)}`, "DELETE");
        assert.equal(deleted, true, "Temporary smoke session cleanup failed");
      }
    } finally {
      await server?.close();
      const delta = relative(resolve(tmpdir()), resolve(root));
      if (delta.startsWith("agentmesh-opencode-smoke-") && !delta.includes(sep) && !delta.includes("..")) rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "OpenCode protocol smoke failed"); process.exitCode = 1; });
