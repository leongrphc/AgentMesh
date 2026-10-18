import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DesktopService } from "../src/desktop/service.js";

test("real PTY uses workspace cwd, resizes, exits, and blocks conflicting desktop actions", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-pty-"));
  const service = new DesktopService(root);
  try {
    service.openDemo();
    assert.throws(() => service.openTerminal("foreign-task", 80, 24), /Geçersiz/);
    await assert.rejects(service.openTerminal("plan", 0, 24), /boyutu/);
    const terminal = await service.openTerminal("plan", 80, 24);
    assert.equal(terminal.cwd, root);
    assert.throws(() => service.start(), /terminal/);
    assert.throws(() => service.retry("plan"), /terminal/);
    assert.throws(() => service.openDemo(), /terminal/);
    service.terminals.resize(terminal.id, 110, 30);
    assert.throws(() => service.terminals.resize(terminal.id, 501, 30), /boyutu/);
    assert.throws(() => service.terminals.write(terminal.id, "x".repeat(8193)), /8192/);
    assert.throws(() => service.terminals.read(terminal.id, -1), /konumu/);
    service.terminals.write(terminal.id, "echo PTY_WORKSPACE_OK> pty-proof.txt\r");
    service.terminals.write(terminal.id, process.platform === "win32" ? "type pty-proof.txt\r" : "cat pty-proof.txt\r");
    service.terminals.write(terminal.id, "exit\r");
    let output = "", offset = 0;
    for (let i = 0; i < 100; i++) {
      const result = service.terminals.read(terminal.id, offset);
      output += result.data; offset = result.offset;
      if (result.exitCode !== undefined) { assert.equal(result.exitCode, 0); break; }
      await delay(100);
    }
    assert.equal(service.terminals.active, false);
    assert.match(output, /PTY_WORKSPACE_OK/);
    assert.match(readFileSync(join(root, "pty-proof.txt"), "utf8"), /PTY_WORKSPACE_OK/);
    assert.throws(() => service.terminals.write(terminal.id, "echo late\r"), /sonlandı/);
    await service.terminals.close(terminal.id);
    assert.throws(() => service.terminals.read(terminal.id, 0), /açık değil/);
    const second = await service.openTerminal("backend", 80, 24);
    service.terminals.write(second.id, 'node -e "require(\'node:fs\').writeFileSync(\'child.pid\',String(process.pid));setInterval(()=>{},1000)"\r');
    for (let i = 0; i < 80 && !existsSync(join(root, "child.pid")); i++) await delay(100);
    const childPid = Number(readFileSync(join(root, "child.pid"), "utf8"));
    await service.close();
    let childAlive = true;
    for (let i = 0; i < 80; i++) {
      try { process.kill(childPid, 0); } catch { childAlive = false; break; }
      await delay(100);
    }
    assert.equal(childAlive, false, "terminal shutdown must stop its foreground child");
    assert.throws(() => service.terminals.read(second.id, 0), /açık değil/);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("PTY tabs and output remain bounded and failed opening releases its slot", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-pty-limits-"));
  const service = new DesktopService(root);
  try {
    service.openDemo();
    await assert.rejects(service.terminals.open("plan", join(root, "missing"), 80, 24));
    assert.equal(service.terminals.count, 0);
    const tabs = await Promise.all(["plan", "backend", "frontend", "review"].map((id) => service.openTerminal(id, 80, 24)));
    await assert.rejects(service.openTerminal("plan", 80, 24), /dört/);
    service.terminals.write(tabs[0]!.id, 'node -e "process.stdout.write(\'x\'.repeat(160000))"\r');
    let result = service.terminals.read(tabs[0]!.id, 0);
    for (let i = 0; i < 100 && result.offset < 150000; i++) {
      await delay(100); result = service.terminals.read(tabs[0]!.id, 0);
    }
    assert.equal(result.truncated, true);
    assert.ok(result.data.length <= 131072);
    assert.equal(service.terminals.read(tabs[0]!.id, result.offset).truncated, false);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
