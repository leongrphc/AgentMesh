import test from "node:test";
import assert from "node:assert/strict";
import { describeEvent, describeOutput, eventTaskId } from "../src/desktop/event-text.js";

test("domain events become readable labels and keep failure reasons", () => {
  assert.equal(describeEvent({ type: "task.started", taskId: "a", agentId: "x", executionId: "e" } as never), "Ajan çalışmaya başladı");
  assert.equal(describeEvent({ type: "task.failed", taskId: "a", error: "RPC bağlantısı kapandı" } as never), "Görev başarısız oldu: RPC bağlantısı kapandı");
  assert.equal(eventTaskId({ type: "task.created", task: { id: "new" } } as never), "new");
  assert.equal(eventTaskId({ type: "project.created", project: { id: "p" } } as never), undefined);
});

test("provider protocol noise is dropped while agent text, files, warnings and errors remain", () => {
  // Adapters report each JSON line as { text: "<json>" }; plain objects are accepted too.
  const wrapped = (data: unknown) => describeOutput({ channel: "stdout", data: { text: JSON.stringify(data) } } as never);
  const direct = (data: unknown) => describeOutput({ channel: "stdout", data } as never);
  for (const out of [wrapped, direct]) {
    assert.equal(out({ method: "mcpServer/startupStatus/updated", params: { name: "x" } }), undefined);
    assert.equal(out({ method: "remoteControl/status/changed", params: {} }), undefined);
    assert.equal(out({ method: "item/agentMessage/delta", params: { delta: "Se" } }), undefined);
    assert.equal(out({ method: "item/completed", params: { item: { type: "userMessage", content: [] } } }), undefined);
    assert.equal(out({ method: "item/completed", params: { item: { type: "agentMessage", text: "Bitti." } } }), "Ajan: Bitti.");
    assert.equal(out({ method: "item/completed", params: { item: { type: "fileChange", changes: [{ path: "math.ts" }] } } }), "Dosya değişti: math.ts");
    assert.equal(out({ method: "error", params: { error: { message: "Reconnecting... 2/5", additionalDetails: "timeout" } } }),
      "Sağlayıcı hatası: Reconnecting... 2/5 — timeout");
    assert.match(out({ method: "error", params: { error: { message: "Reconnecting", additionalDetails: "(os error 10061)" } } })!, /openai_base_url/);
    assert.equal(out({ type: "item.completed", item: { type: "agent_message", text: "Tamam" } }), "Ajan: Tamam");
    assert.equal(out({ type: "thread.started", thread_id: "t" }), undefined);
  }
  const codexText = (text: string) => wrapped({ method: "item/completed", params: { item: { type: "agentMessage", text } } });
  assert.equal(codexText('{"agentmeshVersion":1,"summary":"bitti"}'), undefined);
  assert.equal(codexText('```json\n{"agentmeshVersion":1,"summary":"bitti"}\n```'), undefined);
  assert.equal(wrapped({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status --short" } }] } }), "Komut: git status --short");
  assert.equal(codexText('{"agentmeshMessageVersion":1,"key":"k","to":"*","kind":"progress","body":"math.ts kontrol ediliyor"}'), "Ajan mesajı: math.ts kontrol ediliyor");
  assert.equal(codexText('{"agentmeshMessageVersion":1,"key":"k","to":"claude","kind":"question","body":"API?"}'), "Ajan mesajı → claude: API?");
  assert.equal(wrapped({ method: "item/completed", params: { item: { type: "fileChange", changes: [{ path: "C:\\tmp\\.agentmesh-worktrees\\abc\\def\\src\\math.ts" }] } } }), "Dosya değişti: src/math.ts");
  const claude = (content: unknown[]) => wrapped({ type: "assistant", message: { content } });
  assert.equal(claude([{ type: "tool_use", name: "Edit", input: { file_path: "C:\\work\\repo\\src\\math.ts" } }]), "Düzenliyor: src/math.ts");
  assert.equal(claude([{ type: "text", text: "Ekledim." }, { type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } }]), "Ajan: Ekledim. · Dosya arıyor: **/*.ts");
  assert.equal(claude([{ type: "text", text: '{"agentmeshVersion":1,"summary":"x"}' }]), undefined);
  assert.equal(wrapped({ type: "user", message: { content: [{ type: "tool_result" }] } }), undefined);
  assert.equal(wrapped({ type: "rate_limit_event" }), undefined);
  assert.equal(direct({ text: "demo başladı" }), "demo başladı");
  assert.equal(direct({ text: "{not json" }), "{not json");
  assert.equal(direct({ text: "x".repeat(1000) })!.length, 400);
});
