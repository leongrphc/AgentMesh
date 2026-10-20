import type { BrowserWindow } from "electron";
import type { DesktopService } from "./service.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Real Monaco input, renderer reload, disk conflict and independent tab saves; no provider calls. */
export async function editorSmoke(window: BrowserWindow, service: DesktopService) {
  const wait = `async function wait(check) {
    for (let i=0;i<300;i++) { const result=check(); if(result) return result; await new Promise(r=>setTimeout(r,50)); }
    throw new Error('Editör smoke zaman aşımı');
  }`;
  async function run(code: string) {
    try { return await window.webContents.executeJavaScript(`(async()=>{${wait} ${code}})()`); }
    catch (error) { throw new Error(`${String(error)}; adım: ${code.slice(0, 180)}`); }
  }
  async function type(text: string) {
    await run(`(await wait(()=>document.querySelector('.monaco-editor .native-edit-context') ?? document.querySelector('.monaco-editor textarea.inputarea'))).focus();`);
    window.webContents.debugger.attach("1.3");
    try { await window.webContents.debugger.sendCommand("Input.insertText", { text }); }
    finally { window.webContents.debugger.detach(); }
    await run(`await wait(()=>document.querySelector('.editor-toolbar code')?.textContent.includes('●'));`);
  }
  await type("const firstDraft = 1;");
  service.createEntry("second", "src/smoke-folder/other.ts", false);
  await run(`(await wait(()=>[...document.querySelectorAll('.file-tree>button')].find(e=>e.textContent.trim().endsWith('other.ts')))).click();
    await wait(()=>document.querySelector('.editor-toolbar code')?.textContent==='src/smoke-folder/other.ts');`);
  await type("const secondDraft = 2;");
  await run(`
    if (document.querySelectorAll('.file-tabs [role=tab]').length!==2) throw new Error('İki sekme açılmadı');
    [...document.querySelectorAll('.file-tabs [role=tab]')].find(e=>e.textContent.includes('/new.ts')).click();
    await wait(()=>document.querySelector('.editor-toolbar code')?.textContent.includes('new.ts ●'));
    await wait(()=>Object.keys(localStorage).some(k=>k.startsWith('agentmesh.editor.v1:') && localStorage.getItem(k).includes('firstDraft') && localStorage.getItem(k).includes('secondDraft')));
  `);
  if (service.readFile("second", "src/smoke-folder/new.ts").content !== "") throw new Error("Taslak otomatik olarak disk dosyasına yazıldı");
  await new Promise<void>((resolve) => { window.webContents.once("did-finish-load", () => resolve()); window.webContents.reload(); });
  await run(`
    (await wait(()=>[...document.querySelectorAll('.task-row')].find(e=>e.textContent.includes('Smoke second')))).click();
    await wait(()=>document.querySelectorAll('.file-tabs [role=tab]').length===2);
    await wait(()=>document.documentElement.dataset.unsaved==='true');
  `);
  const root = service.files("second").root;
  writeFileSync(join(root, "src/smoke-folder/new.ts"), "external change");
  await run(`await wait(()=>document.querySelector('.file-workspace [role=status]')?.textContent.includes('diskte değişti'));
    [...document.querySelectorAll('.editor-toolbar button')].find(e=>e.textContent==='Kaydet').click();
    await wait(()=>[...document.querySelectorAll('.file-error')].some(e=>e.textContent.includes('disk üzerinde değişti')));`);
  if (service.readFile("second", "src/smoke-folder/new.ts").content !== "external change") throw new Error("Eski taslak disk değişikliğini ezdi");
  writeFileSync(join(root, "src/smoke-folder/new.ts"), "");
  await run(`
    [...document.querySelectorAll('.editor-toolbar button')].find(e=>e.textContent==='Kaydet').click();
    await wait(()=>!document.querySelector('.editor-toolbar code')?.textContent.includes('●'));
    [...document.querySelectorAll('.file-tabs [role=tab]')].find(e=>e.textContent.includes('/other.ts')).click();
    await wait(()=>document.querySelector('.editor-toolbar code')?.textContent.includes('other.ts ●'));
    [...document.querySelectorAll('.editor-toolbar button')].find(e=>e.textContent==='Kaydet').click();
    await wait(()=>document.documentElement.dataset.unsaved==='false');
  `);
  if (service.readFile("second", "src/smoke-folder/new.ts").content !== "const firstDraft = 1;"
    || service.readFile("second", "src/smoke-folder/other.ts").content !== "const secondDraft = 2;") throw new Error("Sekme taslakları doğru dosyalara kaydedilmedi");
  console.log("Editor smoke başarılı: iki Monaco taslağı, sekme geçişi, reload kurtarma ve disk çakışması doğrulandı");
}
