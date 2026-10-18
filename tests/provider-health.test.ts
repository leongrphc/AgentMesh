import assert from "node:assert/strict";
import { test } from "node:test";
import { probeCodex } from "../src/adapters/provider-health.js";
import { JsonlRpcClient } from "../src/adapters/jsonl-rpc.js";

test("Codex health only initializes/reads account, never refreshes or exposes identity", async () => {
  for (const [account, expected] of [[{ type: "chatgpt", email: "private@example.com", token: "private-token" }, "configured"],
    [null, "needs_login"], [{ type: "future-provider" }, "installed"]] as const) {
    const script = `
      const rl=require('node:readline').createInterface({input:process.stdin});
      rl.on('line',line=>{
        const m=JSON.parse(line);
        const send=(result)=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
        if(m.method==='initialize') return send({userAgent:'test'});
        if(m.method==='initialized') return;
        if(m.method==='account/read'&&m.params.refreshToken===false) return send({account:${JSON.stringify(account)},requiresOpenaiAuth:true});
        process.exit(9);
      });
    `;
    const result = await probeCodex(process.cwd(), undefined, (options) => new JsonlRpcClient({ ...options,
      executable: process.execPath, args: ["-e", script] }));
    assert.equal(result.status, expected);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

test("Codex health reports unavailable for missing processes and aborted probes", async () => {
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await probeCodex(process.cwd(), aborted.signal)).status, "unavailable");
  const result = await probeCodex(process.cwd(), undefined, (options) => new JsonlRpcClient({ ...options,
    executable: "missing-agentmesh-test-executable", args: [] }));
  assert.equal(result.status, "unavailable");
});
