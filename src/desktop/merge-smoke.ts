import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserWindow } from "electron";
import type { AgentTask } from "../core/contracts.js";
import { SqliteJournal } from "../core/sqlite-journal.js";
import { Orchestrator } from "../core/orchestrator.js";
import { WorktreeManager } from "../core/worktrees.js";
import type { DesktopService } from "./service.js";

/** Only invoked by the explicit desktop smoke flag, in that process's isolated fixture directory. */
export async function mergeSmoke(window: BrowserWindow, service: DesktopService) {
  const root = resolve(".agentmesh", "desktop-smoke", String(process.pid), "merge-fixture");
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Smoke"); git(repo, "config", "user.email", "smoke@example.invalid");
  writeFileSync(join(repo, "src/shared.txt"), "initial\n"); git(repo, "add", "."); git(repo, "commit", "-m", "fixture");
  const key = createHash("sha256").update(process.platform === "win32" ? repo.toLowerCase() : repo).digest("hex").slice(0, 16);
  const journal = new SqliteJournal(join(root, ".agentmesh-data", key, "events.sqlite"));
  const manager = new WorktreeManager();
  const tasks: AgentTask[] = ["first", "second"].map((id) => ({ id, agentId: id, projectId: "smoke-merge", title: `Smoke ${id}`,
    instruction: "Local fixture only", allowedPaths: ["src/**"], dependsOn: [] }));
  try {
    const engine = new Orchestrator(journal, manager);
    engine.createProject({ id: "smoke-merge", workspaceRoot: repo });
    for (const task of tasks) {
      engine.registerAgent({ id: task.agentId, provider: "fixture", connection: "cli", async execute({ workspaceRoot }) {
        writeFileSync(join(workspaceRoot, "src/shared.txt"), `${task.id}\n`);
        return { summary: "Local fixture" };
      } });
      engine.addTask(task);
    }
    const pending = await engine.run("smoke-merge", 2);
    engine.approveTask("first", pending.tasks[0]!.review!.digest);
    try { engine.approveTask("second", pending.tasks[1]!.review!.digest); } catch { /* Expected conflict, verified below. */ }
    if (!engine.snapshot("smoke-merge").tasks[1]?.mergeConflict) throw new Error("Smoke merge çakışması oluşmadı");
  } finally { journal.close(); }
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ projectId: "smoke-merge", repoPath: repo, agents: tasks.map((task) => ({ id: task.agentId, provider: "codex" })), tasks }));
  service.openConfig(config);
  await window.webContents.executeJavaScript(`(async () => {
    const wait = async (find) => {
      for (let i = 0; i < 200; i++) { const value = find(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
      throw new Error('Merge smoke arayüzü zaman aşımı');
    };
    (await wait(() => [...document.querySelectorAll('.task-row')].find(e => e.textContent.includes('Smoke second')))).click();
    await wait(() => document.querySelector('.task-detail h3')?.textContent === 'Smoke second');
    (await wait(() => [...document.querySelectorAll('.detail-actions button')].find(e => e.textContent.includes('Değişiklikleri incele')))).click();
    (await wait(() => [...document.querySelectorAll('.merge-resolution button')].find(e => e.textContent.includes('Çözümü görev alanında aç')))).click();
    await wait(() => document.querySelector('.merge-file-list button'));
    document.querySelector('[aria-label="İncelemeyi kapat"]').click();
    await wait(() => !document.querySelector('.review-dialog'));
    (await wait(() => [...document.querySelectorAll('.file-tree>button')].find(e => e.textContent.trim().endsWith('src')))).click();
    await wait(() => document.querySelector('.directory-label code')?.textContent === 'src');
    const create = async (name, kind) => {
      const form = await wait(() => document.querySelector('form.create-entry'));
      const select = form.querySelector('select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, kind);
      select.dispatchEvent(new Event('change', {bubbles:true}));
      const input = form.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name);
      input.dispatchEvent(new Event('input', {bubbles:true}));
      await wait(() => !form.querySelector('button').disabled);
      form.requestSubmit();
      await wait(() => form.querySelector('[role="status"]')?.textContent.includes(name + ' oluşturuldu'));
      return wait(() => [...document.querySelectorAll('.file-tree>button')].find(e => e.textContent.trim().endsWith(name)));
    };
    (await create('smoke-folder', 'directory')).click();
    await wait(() => document.querySelector('.directory-label code')?.textContent === 'src/smoke-folder');
    (await create('new.ts', 'file')).click();
    await wait(() => document.querySelector('.editor-toolbar code')?.textContent === 'src/smoke-folder/new.ts');
    document.querySelector('.file-workspace').scrollIntoView({block:'center'});
    await new Promise(resolve => { const timer = setTimeout(resolve, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
  })()`);
  const bounds = await window.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.file-workspace').getBoundingClientRect();
    return {x:r.x + scrollX, y:r.y + scrollY, width:r.width, height:r.height, scale:1};
  })()`);
  window.webContents.debugger.attach("1.3");
  try {
    const shot = await window.webContents.debugger.sendCommand("Page.captureScreenshot", {format:"png", captureBeyondViewport:true, clip:bounds});
    writeFileSync(resolve("dist", "desktop-create-file.png"), Buffer.from(shot.data, "base64"));
  } finally { window.webContents.debugger.detach(); }
  if (service.readFile("second", "src/smoke-folder/new.ts").content !== "") throw new Error("Yeni dosya diskte doğrulanamadı");
  await window.webContents.executeJavaScript(`(async () => {
    const wait = async (find) => {
      for (let i = 0; i < 200; i++) { const value = find(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
      throw new Error('Merge smoke arayüzü zaman aşımı');
    };
    (await wait(() => [...document.querySelectorAll('.detail-actions button')].find(e => e.textContent.includes('Değişiklikleri incele')))).click();
    (await wait(() => document.querySelector('.merge-file-list button'))).click();
    const editor = await wait(() => document.querySelector('[aria-label="Çakışma çözümü"]'));
    if (!editor.value.includes('<<<<<<< HEAD')) throw new Error('Çakışma içeriği açılmadı');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, 'UI resolved\\n');
    editor.dispatchEvent(new Event('input', {bubbles:true}));
    await wait(() => document.documentElement.dataset.unsaved === 'true');
    document.querySelector('.merge-resolution form').requestSubmit();
    await wait(() => document.querySelector('.merge-resolution')?.textContent.includes('Dosya çakışmaları çözüldü'));
    const approve = [...document.querySelectorAll('.review-actions button')].find(e => e.textContent.includes('Onayla ve birleştir'));
    if (!approve || approve.disabled) throw new Error('Çözüm yeni onaya hazırlanmadı');
    document.querySelector('.merge-resolution').scrollIntoView({block:'center'});
    await new Promise(resolve => { const timer = setTimeout(resolve, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
  })()`);
  writeFileSync(resolve("dist", "desktop-merge.png"), (await window.capturePage()).toPNG());
  // Native confirmation is not clicked by automation; approve the verified fixture via the service.
  const review = service.review("second");
  service.approve("second", review.inspection.digest);
  if (service.state().snapshot.tasks[1]?.status !== "completed"
    || readFileSync(join(manager.integration(repo).path, "src/shared.txt"), "utf8").trim() !== "UI resolved"
    || readFileSync(join(repo, "src/shared.txt"), "utf8").trim() !== "initial") throw new Error("Smoke merge sonucu doğrulanamadı");
  console.log("Merge smoke başarılı: gerçek Git çakışması, renderer çözümü, IPC kaydı ve digest onayı doğrulandı");
}
