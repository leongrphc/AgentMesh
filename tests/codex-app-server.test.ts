import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { JsonlRpcClient } from "../src/adapters/jsonl-rpc.js";
import type { AgentExecution } from "../src/core/contracts.js";

const input = (): AgentExecution => ({ workspaceRoot: process.cwd(), task: { id: "t", projectId: "p", agentId: "a", title: "test",
  instruction: "test", dependsOn: [], allowedPaths: ["src/**"] }, inbox: [], context: {} });

function serverScript(mode: string): string {
  return `
    const mode = ${JSON.stringify(mode)};
    const rl = require('node:readline').createInterface({input:process.stdin});
    const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
    const notify = (method, params) => send({method,params});
    const scoped = (extra={}) => ({threadId:'thread-1',turnId:'turn-1',...extra});
    const complete = (text) => {
      notify('item/completed',scoped({item:{type:'agentMessage',text}}));
      notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
    };
    rl.on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') return send({id:m.id,result:{userAgent:'fake'}});
      if(m.method==='initialized') return;
      if(m.method==='thread/start'||m.method==='thread/resume') {
        if(mode==='conversation') {
          if(m.params.sandbox!=='read-only'||m.params.approvalPolicy!=='never'||m.params.ephemeral!==true||m.params.config['features.shell_tool']!==false) process.exit(9);
          return send({id:m.id,result:{thread:{id:'thread-1'}}});
        }
        if(m.params.approvalPolicy!=='on-request'||m.params.approvalsReviewer!=='user'||m.params.sandbox!=='workspace-write') process.exit(9);
        return send({id:m.id,result:{thread:{id:'thread-1'}}});
      }
      if(m.method==='turn/start') {
        if(mode==='conversation') {
          if(m.params.input[0].text!=='test'||m.params.sandboxPolicy.type!=='readOnly'||m.params.approvalPolicy!=='never') process.exit(9);
          send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
          return complete('Selam!');
        }
        if(m.params.sandboxPolicy.networkAccess!==false) process.exit(9);
        send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
        notify('turn/started',{threadId:'thread-1',turn:{id:'turn-1'}});
        if(mode==='live'||mode==='wrong-steer') {
          notify('item/completed',scoped({item:{type:'agentMessage',text:JSON.stringify({
            agentmeshMessageVersion:1,key:'question-1',to:'reviewer',kind:'question',body:'Please check'
          })}}));
          return;
        }
        let params=scoped({itemId:'tool-1',command:'npm test',cwd:process.cwd()});
        if(mode==='wrong-thread') params.threadId='other-thread';
        if(mode==='extra-permissions') params.additionalPermissions={network:{enabled:true}};
        if(mode==='network') params.networkApprovalContext={host:'example.com'};
        if(mode==='disconnect') return process.exit(0);
        if(mode==='file'||mode==='grant-root') {
          notify('item/started',scoped({item:{id:'tool-1',type:'fileChange',changes:[{path:'src/feature.ts'}]}}));
          if(mode==='grant-root') params.grantRoot=process.cwd();
          return send({id:'permission-1',method:'item/fileChange/requestApproval',params});
        }
        if(mode==='permission-subset') return send({id:'permission-1',method:'item/permissions/requestApproval',params});
        send({id:'permission-1',method:'item/commandExecution/requestApproval',params});
        notify('item/agentMessage/delta',scoped({delta:'still streaming'}));
        return;
      }
      if(m.method==='turn/steer') {
        if(m.params.threadId!=='thread-1'||m.params.expectedTurnId!=='turn-1'||!m.params.input[0].text.includes('incoming-1')) process.exit(9);
        complete('Task complete');
        notify('item/completed',scoped({item:{type:'agentMessage',text:JSON.stringify({
          agentmeshMessageVersion:1,key:'late',to:'reviewer',kind:'progress',body:'Too late'
        })}}));
        return send({id:m.id,result:{turnId:mode==='wrong-steer'?'other-turn':'turn-1'}});
      }
      if(m.id==='permission-1') {
        if(mode==='permission-subset') return complete(JSON.stringify(m.result));
        complete(m.result?.decision??'error');
      }
    });
  `;
}

function adapter(mode: string) {
  return new CodexAppServerAdapter("a", { conversationOnly: mode === "conversation", clientFactory: (options) => new JsonlRpcClient({ ...options,
    // Cold child startup under the parallel Windows suite can exceed one second.
    executable: process.execPath, args: ["-e", serverScript(mode)], timeoutMs: 10000, requestTimeoutMs: 3000 }) });
}

test("Codex message test uses ephemeral read-only thread and sends only the user message", async () => {
  assert.equal((await adapter("conversation").execute(input())).summary, "Selam!");
});

test("Codex App Server streams while waiting, supports resume and grants only accept-once", async () => {
  let prompts = 0, streaming = false;
  const output = await adapter("command").execute({ ...input(), sessionId: "thread-1",
    onOutput: (value) => { if (JSON.stringify(value).includes("still streaming")) streaming = true; },
    requestPermission: async (proposal) => {
      prompts++; assert.equal(proposal.kind, "command");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(streaming, true); return "allow_once";
    },
  });
  assert.equal(prompts, 1); assert.equal(output.summary, "accept"); assert.equal(output.sessionId, "thread-1");
  assert.equal((await adapter("file").execute({ ...input(), requestPermission: async () => "allow_once" })).summary, "accept");
});

test("Codex App Server denies wrong scope, session grants, network and unsupported extra permissions", async () => {
  for (const mode of ["wrong-thread", "grant-root", "network", "extra-permissions"]) {
    let prompts = 0;
    const result = await adapter(mode).execute({ ...input(), requestPermission: async () => { prompts++; return "allow_once"; } });
    assert.equal(result.summary, "decline"); assert.equal(prompts, 0);
  }
  assert.equal((await adapter("command").execute(input())).summary, "decline");
  assert.equal((await adapter("command").execute({ ...input(), requestPermission: async () => "deny" })).summary, "decline");
  const subset = await adapter("permission-subset").execute({ ...input(), requestPermission: async () => "allow_once" });
  assert.deepEqual(JSON.parse(subset.summary), { permissions: {}, scope: "turn" });
});

test("Codex transport abort and disconnect reject a turn without publishing a successful result", async () => {
  await assert.rejects(adapter("disconnect").execute(input()), /bağlantısı kapandı/);
  const abort = new AbortController();
  await assert.rejects(adapter("command").execute({ ...input(), signal: abort.signal,
    requestPermission: async () => { abort.abort(); return "allow_once"; },
  }), /iptal edildi/);
});

test("RPC transport stops oversized or invalid records and times out unanswered requests", async () => {
  for (const [script, expected] of [
    ["process.stdout.write('x'.repeat(2000));setInterval(()=>{},1000)", /satır limiti/],
    ["process.stdout.write('invalid\\n');setInterval(()=>{},1000)", /Geçersiz/],
    ["setInterval(()=>{},1000)", /yanıt süresi/],
  ] as const) {
    const client = new JsonlRpcClient({ executable: process.execPath, args: ["-e", script], cwd: process.cwd(),
      maxLineBytes: 1024, requestTimeoutMs: 500, timeoutMs: 5000,
      onNotification() {}, async onRequest() { return {}; }, onExit() {} });
    try { await assert.rejects(client.request("initialize", {}), expected); }
    finally { await client.close(); }
  }
});

test("Codex live inbox binds the active turn, waits for steer acknowledgement and ignores post-completion messages", async () => {
  for (const mode of ["live", "wrong-steer"]) {
    let accepted = false, acknowledged = false, deliveryError = "";
    const sent: string[] = [];
    const output = await adapter(mode).execute({ ...input(), liveMessages: true,
      acknowledgeInbox: () => { acknowledged = true; },
      sendMessage: (message) => { sent.push(message.idempotencyKey); return "outgoing-1"; },
      subscribeInbox: (handler) => {
        assert.equal(acknowledged, true);
        const pending = handler({ id: "incoming-1", projectId: "p", taskId: "other", from: "reviewer", to: "a",
          kind: "progress", body: "Keep scope small", createdAt: "" })
          .then((value) => { accepted = value; }, (error: unknown) => { deliveryError = String(error); });
        return async () => { await pending; };
      },
    });
    assert.equal(output.summary, "Task complete");
    assert.deepEqual(sent, ["question-1"]);
    assert.equal(accepted, mode === "live");
    if (mode === "wrong-steer") assert.match(deliveryError, /farklı tura/);
  }
});
