import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenCodeServerClient, validateOpenCodeSchema } from "../src/adapters/opencode-server-client.js";
import { OpenCodeServerAdapter, hasOpenCodeSessionPolicy, openCodeSessionRules } from "../src/adapters/opencode-server.js";
import { probeOpenCodeServer } from "../src/adapters/provider-health.js";
import { validate } from "../src/core/config.js";
import { configuredAdapter } from "../src/adapters/registry.js";
import type { AgentExecution } from "../src/core/contracts.js";

// Extracted from local OpenCode 1.19.3 /doc, not a manually invented provider schema.
const schema = JSON.parse(readFileSync(new URL("./fixtures/opencode-schema-excerpt.json", import.meta.url), "utf8"));

function fakeServer(mode: string, audit: string): string {
  return `
    const http=require('node:http'), fs=require('node:fs');
    const mode=${JSON.stringify(mode)}, audit=${JSON.stringify(audit)}, schema=${JSON.stringify(schema)};
    const auth='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
    let permission=mode==='edit'?[{permission:'*',pattern:'*',action:'allow'}]:[], pending, permissionReads=0, streams=[], messageResponse, messageBody;
    const requests=[];
    const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
    const send=(type,properties)=>streams.forEach(res=>res.write('data: '+JSON.stringify({type,properties})+'\\r\\n\\r\\n'));
    const finish=(text)=>{
      if(!messageResponse||messageResponse.writableEnded) return;
      json(messageResponse,{info:{id:'msg_assistant',sessionID:'ses_test',parentID:mode==='wrong-parent'?'old-message':messageBody.messageID,role:'assistant',time:{completed:Date.now()},finish:'stop'},
        parts:[{type:'text',sessionID:'ses_test',messageID:'msg_assistant',text}]});
    };
    const session=()=>({id:'ses_test',directory:mode==='wrong-directory'?require('node:path').dirname(process.cwd()):process.cwd(),permission});
    http.createServer((req,res)=>{
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.headers.authorization!==auth) return json(res,{},mode==='no-auth'?200:401);
      let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
        const parsed=body?JSON.parse(body):undefined;
        requests.push({method:req.method,path:url.pathname,body:parsed,directory:url.searchParams.get('directory')});
        fs.writeFileSync(audit,JSON.stringify(requests));
        const path=url.pathname;
        if(path==='/global/health') return json(res,{healthy:true,version:mode==='bad-version'?'2.0.0':'1.19.3'});
        if(path==='/doc') return json(res,schema);
        if(path==='/path') return json(res,{directory:process.cwd()});
        if(path==='/provider') return json(res,{all:[{id:'test',private:'provider-secret'}],default:{test:'model'},connected:mode==='no-provider'?[]:mode==='bad-provider'?'private':['test']});
        if(path==='/event') {
          res.writeHead(200,{'Content-Type':'text/event-stream'});
          res.write('data: '+JSON.stringify({type:'server.connected',properties:{}})+'\\n\\n');
          streams.push(res); return;
        }
        if(path==='/session/status') return json(res,mode==='busy'?{ses_test:{type:'busy'}}:{});
        if(path==='/session'&&req.method==='POST') {
          permission=parsed.permission;
          if(mode==='bad-policy') permission=[{permission:'*',pattern:'*',action:'allow'}];
          return json(res,session());
        }
        if(path==='/session/ses_test'&&req.method==='GET') return json(res,session());
        if(path==='/session/ses_test'&&req.method==='PATCH') {permission=[...permission,...parsed.permission];return json(res,session())};
        if(path==='/permission') {
          if(!pending) return json(res,[]);
          permissionReads++;
          return json(res,[mode==='mutated'&&permissionReads>1?{...pending,metadata:{command:'different-command'}}:pending]);
        }
        if(path==='/session/ses_test/abort') {
          pending=undefined; finish('aborted'); return json(res,true);
        }
        if(path==='/session/ses_test/message') {
          messageResponse=res; messageBody=parsed;
          if(mode==='disconnect') { streams.forEach(s=>s.end()); return; }
          if(mode==='oversized') { streams.forEach(s=>s.write('data: '+'x'.repeat(1024*1024+1)+'\\n\\n'));return; }
          if(mode==='question') { send('question.asked',{sessionID:'ses_test',id:'que_test'});return; }
          if(mode==='wrong-session') {
            send('permission.asked',{id:'per_other',sessionID:'ses_other',permission:'bash',patterns:['other-command'],metadata:{},always:[]});
            return finish('foreign ignored');
          }
          pending={id:'per_check',sessionID:'ses_test',permission:mode==='edit'||mode==='outside'?'edit':mode==='unsupported'?'webfetch':'bash',
            patterns:mode==='edit'?['src/feature.ts']:mode==='outside'?['../private.txt']:['npm test'],metadata:{},always:['*']};
          send('permission.asked',pending);
          if(mode==='duplicate') send('permission.asked',pending);
          if(mode==='withdraw') setTimeout(()=>{
            pending=undefined;send('permission.replied',{sessionID:'ses_test',requestID:'per_check',reply:'reject'});finish('withdrawn');
          },30);
          send('message.part.delta',{sessionID:'ses_test',delta:'live while waiting'});return;
        }
        if(path==='/permission/per_check/reply') {
          if(!pending) return json(res,{},404);
          pending=undefined;send('permission.replied',{sessionID:'ses_test',requestID:'per_check',reply:parsed.reply});
          json(res,true);return finish(parsed.reply);
        }
        return json(res,{},404);
      });
    }).listen(0,'127.0.0.1',function(){console.log('opencode server listening on http://127.0.0.1:'+this.address().port)});
  `;
}

function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "mesh-opencode-"));
  const audit = join(root, "audit.json");
  const options = { cwd: root, executable: process.execPath, args: ["-e", fakeServer(mode, audit)], startupTimeoutMs: 3000, timeoutMs: 5000 };
  const adapter = new OpenCodeServerAdapter("a", { model: "test/model", serverFactory: (input) => OpenCodeServerClient.start({ ...options, signal: input.signal }) });
  const input: AgentExecution = { task: { id: "t", projectId: "p", title: "test", instruction: "test", agentId: "a", dependsOn: [], allowedPaths: ["src/**"] }, workspaceRoot: root, inbox: [], context: {} };
  return { root, audit: () => JSON.parse(readFileSync(audit, "utf8")) as Array<{ method: string; path: string; body?: Record<string, unknown> }>, options, adapter, input,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("OpenCode validates authentication/schema and bridges once while SSE continues streaming", async () => {
  const f = fixture("duplicate");
  let prompts = 0, streaming = false, saved = "";
  try {
    const result = await f.adapter.execute({ ...f.input, onSession: (id) => { saved = id; },
      onOutput: (output) => { if (JSON.stringify(output).includes("live while waiting")) streaming = true; },
      requestPermission: async (proposal) => {
        prompts++; assert.equal(proposal.provider, "opencode"); assert.equal(proposal.kind, "command");
        await new Promise((done) => setTimeout(done, 30)); assert.equal(streaming, true); return "allow_once";
      },
    });
    assert.equal(prompts, 1); assert.equal(saved, "ses_test"); assert.equal(result.summary, "once");
    const replies = f.audit().filter((request) => request.path.includes("/reply"));
    assert.deepEqual(replies.map((request) => request.body), [{ reply: "once" }]);
    const policies = f.audit().find((request) => request.path === "/session" && request.method === "POST")!.body!.permission as Array<{ action: string }>;
    assert.ok(policies.every((rule) => rule.action !== "allow"));
  } finally { f.cleanup(); }
});

test("OpenCode resume rebinds session policy, file scope and one-request denial", async () => {
  const f = fixture("edit");
  try {
    const result = await f.adapter.execute({ ...f.input, sessionId: "ses_test", requestPermission: async (proposal) => { assert.equal(proposal.kind, "file"); return "deny"; } });
    assert.equal(result.summary, "reject");
    assert.ok(f.audit().some((request) => request.method === "PATCH" && request.path === "/session/ses_test"));
  } finally { f.cleanup(); }
  for (const mode of ["outside", "unsupported", "wrong-session"]) {
    const f = fixture(mode); let prompts = 0;
    try {
      const result = await f.adapter.execute({ ...f.input, requestPermission: async () => { prompts++; return "allow_once"; } });
      assert.equal(prompts, 0); assert.equal(result.summary, mode === "wrong-session" ? "foreign ignored" : "reject");
    } finally { f.cleanup(); }
  }
});

test("OpenCode revocation aborts the pending prompt without sending a stale once grant", async () => {
  const f = fixture("withdraw");
  try {
    const result = await f.adapter.execute({ ...f.input, requestPermission: async (_proposal, signal) => {
      return new Promise((done) => { signal!.addEventListener("abort", () => done("deny"), { once: true }); });
    } });
    assert.equal(result.summary, "withdrawn");
    assert.ok(!f.audit().some((request) => request.path.includes("/reply")));
  } finally { f.cleanup(); }
});

test("OpenCode fails closed for mismatched policy/session, mutated permissions, disconnect and oversized SSE", async () => {
  for (const mode of ["bad-policy", "wrong-directory", "busy", "mutated", "disconnect", "oversized", "question", "wrong-parent"]) {
    const f = fixture(mode);
    try {
      await assert.rejects(f.adapter.execute({ ...f.input, ...(mode === "busy" || mode === "wrong-directory" ? { sessionId: "ses_test" } : {}), requestPermission: async () => "allow_once" }));
      if (mode === "mutated") assert.ok(!f.audit().some((request) => request.body?.reply === "once"));
    } finally { f.cleanup(); }
  }
});

test("OpenCode rejects unauthenticated/incompatible servers before creating a session", async () => {
  for (const mode of ["no-auth", "bad-version"]) {
    const f = fixture(mode);
    try { await assert.rejects(OpenCodeServerClient.start(f.options)); }
    finally { f.cleanup(); }
  }
  validateOpenCodeSchema(schema, "1.19.3");
  const broken = structuredClone(schema); delete broken.paths["/permission/{requestID}/reply"];
  assert.throws(() => validateOpenCodeSchema(broken, "1.19.3"), /desteklenmiyor/);
  assert.throws(() => validateOpenCodeSchema(schema, "2.0.0"), /desteklenmiyor/);
});

test("OpenCode cancellation stops the owned server and preserves the early session ID", async () => {
  const f = fixture("duplicate"); const abort = new AbortController(); let saved = "";
  try {
    await assert.rejects(f.adapter.execute({ ...f.input, signal: abort.signal, onSession: (id) => { saved = id; },
      requestPermission: async () => { abort.abort(); return "allow_once"; } }));
    assert.equal(saved, "ses_test");
    assert.ok(!f.audit().some((request) => request.body?.reply === "once"));
  } finally { f.cleanup(); }
});

test("OpenCode provider health projects connection status without leaking provider data or calling a model", async () => {
  for (const [mode, model, status] of [["health", "test/model", "configured"], ["health", "other/model", "needs_setup"],
    ["no-provider", undefined, "needs_setup"], ["bad-provider", undefined, "unavailable"]] as const) {
    const f = fixture(mode);
    try {
      const health = await probeOpenCodeServer(f.root, model, undefined, (options) => OpenCodeServerClient.start({ ...f.options, signal: options.signal }));
      assert.equal(health.status, status);
      assert.ok(!JSON.stringify(health).includes("private")); assert.ok(!JSON.stringify(health).includes("provider-secret"));
      assert.ok(f.audit().every((request) => request.method === "GET"));
      assert.ok(!f.audit().some((request) => request.path.includes("/session")));
    } finally { f.cleanup(); }
  }
});

test("OpenCode native appended policies and transport selection preserve deny-by-default semantics", () => {
  const allow = { permission: "*", pattern: "*", action: "allow" };
  assert.equal(hasOpenCodeSessionPolicy([allow, ...openCodeSessionRules, ...openCodeSessionRules]), true);
  assert.equal(hasOpenCodeSessionPolicy([...openCodeSessionRules, allow]), false);
  assert.equal(hasOpenCodeSessionPolicy(openCodeSessionRules.slice(1)), false);
  const agent = { id: "a", provider: "opencode" as const, transport: "server" as const, model: "test/model" };
  validate({ projectId: "p", repoPath: ".", agents: [agent], tasks: [] });
  assert.equal(configuredAdapter(agent).interactivePermissions, true);
  assert.throws(() => validate({ projectId: "p", repoPath: ".", agents: [{ ...agent, model: "invalid-model" }], tasks: [] }));
  assert.throws(() => validate({ projectId: "p", repoPath: ".", agents: [{ ...agent, provider: "codex" }], tasks: [] }));
});
