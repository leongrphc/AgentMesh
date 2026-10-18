import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";

test("desktop service cancels, retries and restores persisted demo without calling providers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-desktop-"));
  const service = new DesktopService(root);
  try {
    const initial = service.openDemo();
    assert.equal(initial.snapshot.tasks.length, 4);
    initial.snapshot.tasks[0]!.title = "mutated outside";
    assert.notEqual(service.state().snapshot.tasks[0]!.title, "mutated outside");
    const finished = new Promise<void>((resolve) => {
      let started = false;
      const off = service.subscribe((state) => {
        if (state.busy) started = true;
        if (started && !state.busy) { off(); resolve(); }
      });
    });
    service.start();
    assert.equal(service.state().busy, true);
    assert.throws(() => service.start(), /zaten/);
    assert.throws(() => service.openDemo(), /durdurun/);
    service.cancel();
    await finished;
    assert.ok(service.state().snapshot.tasks.every((task) => task.status === "cancelled"));
    service.retry("plan");
    assert.equal(service.state().snapshot.tasks[0]?.status, "pending");
    assert.throws(() => service.retry("not-a-task"), /Geçersiz/);
    await service.close();
    service.openDemo();
    assert.equal(service.state().snapshot.tasks[0]?.status, "pending");
    assert.equal(service.state().snapshot.tasks[1]?.status, "cancelled");
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
