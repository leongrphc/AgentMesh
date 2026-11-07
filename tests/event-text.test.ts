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
  const out = (data: unknown) => describeOutput({ channel: "stdout", data } as never);
  assert.equal(out({ method: "mcpServer/startupStatus/updated", params: { name: "x" } }), undefined);
  assert.equal(out({ method: "item/agentMessage/delta", params: { delta: "Se" } }), undefined);
  assert.equal(out({ method: "item/completed", params: { item: { type: "userMessage", content: [] } } }), undefined);
  assert.equal(out({ method: "item/completed", params: { item: { type: "agentMessage", text: "Bitti." } } }), "Ajan: Bitti.");
  assert.equal(out({ method: "item/completed", params: { item: { type: "fileChange", changes: [{ path: "math.ts" }] } } }), "Dosya değişti: math.ts");
  assert.equal(out({ method: "error", params: { error: { message: "Reconnecting... 2/5", additionalDetails: "os error 10061" } } }),
    "Sağlayıcı hatası: Reconnecting... 2/5 — os error 10061");
  assert.equal(out({ text: "demo başladı" }), "demo başladı");
  assert.equal(out({ text: "x".repeat(1000) })!.length, 400);
});
