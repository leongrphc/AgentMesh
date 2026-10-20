import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { DesktopService } from "./service.js";
import { safeLog } from "../core/safe-log.js";
import type { TaskDraft } from "./contracts.js";
import type { AgentConfig } from "../core/config.js";
import type { ProviderMessageInput } from "../adapters/provider-message.js";

protocol.registerSchemesAsPrivileged([{ scheme: "agentmesh", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const origin = "agentmesh://desktop";
const windowSmoke = process.argv.includes("--window-smoke-test");
const nativeTuiSmoke = process.argv.includes("--opencode-tui-smoke-test");
const smoke = process.argv.includes("--smoke-test") || windowSmoke || nativeTuiSmoke;
if (smoke) {
  const smokeProfile = resolve(".agentmesh", "desktop-smoke", String(process.pid), "electron-profile");
  mkdirSync(smokeProfile, { recursive: true });
  app.setPath("userData", smokeProfile);
}
let window: BrowserWindow | undefined;
let service: DesktopService;
let quitting = false;

async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 950, minWidth: 960, minHeight: 640,
    show: false, backgroundColor: "#17222d", title: "AgentMesh",
    webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: !smoke },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const current = window;
  let closing = false;
  let checkingClose = false;
  current.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    if (checkingClose) return;
    checkingClose = true;
    void (async () => {
      const dirty = await current.webContents.executeJavaScript(`document.documentElement.dataset.unsaved === 'true'`).catch(() => false);
      if (dirty) {
        const result = await dialog.showMessageBox(current, { type: "question", title: "Kaydedilmemiş değişiklikler",
          message: "Dosya değişikliklerini kaydetmeden çıkılsın mı?", buttons: ["Çalışmaya dön", "Kaydetmeden çık"], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return;
      }
      closing = true;
      await service.close();
      current.destroy();
    })().catch((error) => console.error(safeLog(String(error)))).finally(() => { checkingClose = false; });
  });
  await window.loadURL(`${origin}/index.html`);
  if (!smoke || windowSmoke) {
    window.show();
    window.focus();
    console.log("AgentMesh penceresi açıldı");
  }
  if (windowSmoke && !window.isVisible()) throw new Error("Masaüstü penceresi görünür değil");
  if (smoke) {
    try {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Renderer hazır değil')), 10000);
        const check = setInterval(() => { if (document.querySelector('[data-testid="start"]')) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      const isolation = await window.webContents.executeJavaScript(`({ node: typeof window.require, api: typeof window.agentmesh?.start })`);
      if (isolation.node !== "undefined" || isolation.api !== "function") throw new Error("Preload izolasyonu başarısız");
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Monaco veya dosya ağacı açılmadı')), 10000);
        const check = setInterval(() => {
          const file = [...document.querySelectorAll('.file-tree>button')].find((button) => button.textContent.includes('DEMO.md'));
          if (document.querySelector('.monaco-editor') && file) {
            file.click(); clearInterval(check); clearTimeout(timeout); resolve(true);
          }
        }, 50);
      })`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Demo dosyası editörde görüntülenmedi')), 10000);
        const check = setInterval(() => {
          if (document.querySelector('.view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('AgentMesh demo')) {
            clearInterval(check); clearTimeout(timeout); resolve(true);
          }
        }, 50);
      })`);
      await window.webContents.executeJavaScript(`(async () => {
        async function waitFor(check, label) {
          for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
          throw new Error(label);
        }
        await waitFor(() => document.querySelector('[data-testid="terminal-open"]'), 'Terminal paneli açılmadı');
        document.querySelector('[data-testid="terminal-open"]').click();
        await waitFor(() => document.querySelector('[data-terminal-id]') && document.querySelector('.xterm'), 'PTY veya xterm açılmadı');
        const id = document.querySelector('[data-terminal-id]').dataset.terminalId;
        await window.agentmesh.terminalResize(id, 105, 28);
        await window.agentmesh.terminalWrite(id, 'echo DESKTOP_PTY_OK> terminal-smoke.txt\\r');
        await window.agentmesh.terminalWrite(id, ${JSON.stringify(process.platform === "win32" ? "type terminal-smoke.txt\r" : "cat terminal-smoke.txt\r")});
        await waitFor(async () => (await window.agentmesh.terminalRead(id, 0)).data.includes('DESKTOP_PTY_OK'), 'PTY çıktısı alınmadı');
        document.querySelector('.terminal-panel').scrollIntoView();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const terminalBounds = await window.webContents.executeJavaScript(`(() => {
        const r = document.querySelector('.terminal-panel').getBoundingClientRect();
        return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 };
      })()`);
      window.webContents.debugger.attach("1.3");
      try {
        const screenshot = await window.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: terminalBounds });
        writeFileSync(resolve("dist", "desktop-terminal.png"), Buffer.from(screenshot.data, "base64"));
      } finally { window.webContents.debugger.detach(); }
      await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-testid="terminal-close"]').click();
        for (let i = 0; i < 200; i++) {
          if (!document.querySelector('[data-terminal-id]')) return;
          await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('Terminal kapatılamadı');
      })()`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-testid="start"]').click()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('İzin paneli açılmadı')), 10000);
        const check = setInterval(() => {
          const deny = [...document.querySelectorAll('.permission-panel button')].find((button) => button.textContent === 'Reddet');
          if (deny) { clearInterval(check); clearTimeout(timeout); resolve(true); }
        }, 50);
      })`);
      writeFileSync(resolve("dist", "desktop-permission.png"), (await window.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('.permission-panel button')].find((button) => button.textContent === 'Reddet').click()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Demo ekranı tamamlanmadı')), 15000);
        const check = setInterval(() => { if (document.querySelectorAll('.task-row .status.completed').length === 4
          && document.querySelector('[data-testid="start"]').textContent.includes('Ajanları başlat')) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      if (!service.state().snapshot.tasks.every((task) => task.status === "completed")) throw new Error("Demo tamamlanmadı");
      await window.webContents.executeJavaScript(`document.querySelector('[data-testid="create-task"]').click()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Görev formu açılmadı')), 5000);
        const check = setInterval(() => { if (document.querySelector('.task-form form')) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      await window.webContents.executeJavaScript(`(() => {
        const form = document.querySelector('.task-form form');
        form.querySelector('[name="id"]').value = 'smoke-followup';
        form.querySelector('[name="title"]').value = 'Demo sonuçlarını doğrula';
        form.querySelector('[name="instruction"]').value = 'Ortak context sonuçlarını kontrol et.';
        form.querySelector('[name="dependsOn"][value="review"]').checked = true;
        form.requestSubmit();
      })()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Yeni görev kaydedilmedi')), 5000);
        const check = setInterval(() => { if (!document.querySelector('.task-form') && document.querySelectorAll('.task-row').length === 5) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      if (!service.state().snapshot.tasks.some((task) => task.id === "smoke-followup" && task.dependsOn.includes("review"))) throw new Error("Görev bağımlılığı kaydedilmedi");
      await window.webContents.executeJavaScript(`document.querySelector('[data-testid="start"]').click()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Yeni görev tamamlanmadı')), 10000);
        const check = setInterval(() => { if (document.querySelectorAll('.task-row .status.completed').length === 5) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      const root = resolve("dist");
      await window.webContents.executeJavaScript(`(() => {
        const reports = document.querySelector('.task-detail .test-reports');
        if (!reports?.textContent.includes('Çalıştırılmadı') || !reports.textContent.includes('bağımsız olarak çalıştırmadı')) {
          throw new Error('Test raporu veya kaynak açıklaması gösterilmedi');
        }
      })()`);
      mkdirSync(root, { recursive: true });
      await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('.task-detail .test-reports').scrollIntoView({ block: 'center' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      writeFileSync(join(root, "desktop-test-reports.png"), (await window.capturePage()).toPNG());
      writeFileSync(join(root, "desktop-smoke.png"), (await window.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`document.querySelector('.file-workspace').scrollIntoView()`);
      writeFileSync(join(root, "desktop-editor.png"), (await window.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`document.querySelector('[data-testid="agent-center"]').click()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Ajan merkezi açılmadı')), 5000);
        const check = setInterval(() => {
          const button = document.querySelector('[data-testid="check-agents"]');
          if (button) { button.click(); clearInterval(check); clearTimeout(timeout); resolve(true); }
        }, 50);
      })`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Ajan bağlantı sonucu gösterilmedi')), 5000);
        const check = setInterval(() => { if (document.querySelectorAll('.health-status.configured').length === 4) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      await window.webContents.executeJavaScript(`(async () => {
        const form = document.querySelector('[data-testid="agent-settings-form"]');
        const set = (name, value, prototype) => {
          const field = form.querySelector('[name="' + name + '"]');
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('agentId', 'smoke-agent', HTMLInputElement.prototype);
        set('agentModel', 'demo-model', HTMLInputElement.prototype);
        set('agentRole', 'Test kapsamını incele', HTMLTextAreaElement.prototype);
        await new Promise(r => setTimeout(r, 100));
        form.requestSubmit();
        for (let i = 0; i < 100; i++) {
          const state = await window.agentmesh.state();
          const agent = state.agents.find(a => a.id === 'smoke-agent');
          if (agent?.role === 'Test kapsamını incele' && agent?.model === 'demo-model'
            && form.querySelector('[role="status"]')?.textContent.includes('kaydedildi')) return;
          await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('Ajan ayarları formu veya IPC kaydı doğrulanamadı');
      })()`);
      writeFileSync(join(root, "desktop-agents.png"), (await window.capturePage()).toPNG());
      await window.webContents.executeJavaScript(`(async () => {
        const input = document.querySelector('[aria-label="Test mesajı"]');
        const provider = document.querySelector('[aria-label="Test sağlayıcısı"]');
        if (input?.value !== 'Selam' || provider?.options.length !== 4) throw new Error('Mesaj testi formu eksik');
        document.querySelector('[data-testid="send-provider-message"]').click();
        for (let i = 0; i < 100; i++) {
          if (document.querySelector('.agent-center .file-error')?.textContent.includes('Smoke testinde gerçek model çağrısı kapalı')) return;
          await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('Mesaj testi IPC veya hata görünümü doğrulanamadı');
      })()`);
      if (nativeTuiSmoke) {
        await window.webContents.executeJavaScript(`(async () => {
          const select = document.querySelector('[aria-label="Test sağlayıcısı"]');
          select.value = 'opencode'; select.dispatchEvent(new Event('change', {bubbles:true}));
          await new Promise(r => setTimeout(r, 100));
          if (document.querySelector('[aria-label="Test modeli"]').value !== 'opencode/space-bunny-free') throw new Error('Free model varsayılanı yanlış');
          document.querySelector('[data-testid="send-provider-message"]').click();
          for (let i = 0; i < 600; i++) {
            const terminal = document.querySelector('[data-native-terminal-id]');
            if (terminal && document.querySelector('.provider-tui .xterm')) {
              const output = await window.agentmesh.terminalRead(terminal.dataset.nativeTerminalId, 0);
              if (output.data.includes('Space Bunny Free') && Number(terminal.querySelector('.terminal-screen').dataset.outputOffset) >= output.data.indexOf('Space Bunny Free') + 16) {
                terminal.scrollIntoView(); await new Promise(r => setTimeout(r, 600)); return;
              }
            }
            await new Promise(r => setTimeout(r, 100));
          }
          throw new Error('Native OpenCode TUI açılmadı');
        })()`);
        window.webContents.debugger.attach("1.3");
        try {
          const screenshot = await window.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
          writeFileSync(join(root, "desktop-opencode-tui.png"), Buffer.from(screenshot.data, "base64"));
        } finally { window.webContents.debugger.detach(); }
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('[data-testid="close-native-opencode"]').click();
          for(let i=0;i<150;i++) { if (!document.querySelector('[data-native-terminal-id]')) return; await new Promise(r=>setTimeout(r,100)); }
          throw new Error('Native OpenCode kapanmadı');
        })()`);
      }
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Ajan merkezini kapat"]').click()`);
      console.log("Desktop smoke başarılı: sandbox, preload, Monaco, gerçek PTY ve demo görevleri doğrulandı");
      app.quit();
    } catch (error) {
      console.error(error);
      writeFileSync(resolve("dist", "desktop-error.png"), (await window.capturePage()).toPNG());
      await service.close(); app.exit(1);
    }
  }
}

app.whenReady().then(async () => {
  service = new DesktopService(smoke ? resolve(".agentmesh", "desktop-smoke", String(process.pid)) : join(app.getPath("userData"), "projects"));
  service.openDemo();
  const rendererRoot = resolve(__dirname, "../renderer");
  protocol.handle("agentmesh", (request) => {
    const url = new URL(request.url);
    if (url.host !== "desktop" || request.method !== "GET") return new Response(null, { status: 403 });
    let path: string;
    try { path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`); }
    catch { return new Response(null, { status: 400 }); }
    const suffix = relative(rendererRoot, path);
    if (suffix.startsWith("..") || isAbsolute(suffix)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(path).href);
  });
  function handle(channel: string, action: (...args: unknown[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error("Yetkisiz IPC kaynağı");
      try { return await action(...args); }
      catch (error) { throw new Error(safeLog(error instanceof Error ? error.message : String(error))); }
    });
  }
  handle("mesh:state", () => service.state());
  handle("mesh:provider-terminal", (model) => service.openProviderTerminal(model as string | undefined));
  handle("mesh:test-provider", (input) => {
    if (smoke) throw new Error("Smoke testinde gerçek model çağrısı kapalı");
    return service.testProvider(input as ProviderMessageInput);
  });
  handle("mesh:cancel-provider-test", () => service.cancelProviderTest());
  handle("mesh:terminal-open", (taskId, cols, rows) => service.openTerminal(taskId as string, cols as number, rows as number));
  handle("mesh:terminal-read", (id, offset) => service.terminals.read(id as string, offset as number));
  handle("mesh:terminal-write", (id, data) => service.terminals.write(id as string, data as string));
  handle("mesh:terminal-resize", (id, cols, rows) => service.terminals.resize(id as string, cols as number, rows as number));
  handle("mesh:terminal-close", (id) => service.closeTerminal(id as string));
  handle("mesh:check-agents", () => service.checkAgents());
  handle("mesh:demo", () => service.openDemo());
  handle("mesh:open", async () => {
    if (service.state().busy) throw new Error("Proje açmadan önce çalışmayı durdurun");
    const result = await dialog.showOpenDialog(window!, { title: "AgentMesh proje ayarlarını aç",
      properties: ["openFile"], filters: [{ name: "AgentMesh config", extensions: ["json"] }] });
    return result.canceled ? service.state() : service.openConfig(result.filePaths[0]!);
  });
  handle("mesh:start", async () => {
    if (!service.state().demo) {
      const result = await dialog.showMessageBox(window!, { type: "question", title: "Ajanları başlat",
        message: "Bu projedeki CLI ajanları çalıştırılsın mı?",
        detail: "Bağlı sağlayıcı hesabınız kullanılır; kullanım maliyeti oluşabilir. Değişiklikler ayrı görev worktree’lerinde yapılır.",
        buttons: ["Vazgeç", "Ajanları başlat"], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    service.start();
  });
  handle("mesh:cancel", (taskId) => {
    if (taskId !== undefined && typeof taskId !== "string") throw new Error("Geçersiz görev kimliği");
    service.cancel(taskId as string | undefined);
  });
  handle("mesh:retry", (taskId) => {
    if (typeof taskId !== "string") throw new Error("Geçersiz görev kimliği");
    service.retry(taskId);
  });
  handle("mesh:review", (taskId, refresh = false) => {
    if (typeof taskId !== "string" || typeof refresh !== "boolean") throw new Error("Geçersiz görev kimliği");
    return service.review(taskId, refresh);
  });
  handle("mesh:approve", async (taskId, digest) => {
    if (typeof taskId !== "string" || typeof digest !== "string") throw new Error("Geçersiz onay");
    const review = service.review(taskId);
    if (!review.canApprove || review.inspection.digest !== digest) throw new Error("Değişiklikler yeniden incelenmeli");
    const result = await dialog.showMessageBox(window!, { type: "question", title: "Değişiklikleri onayla",
      message: `${review.title} değişiklikleri entegrasyon dalına alınsın mı?`,
      detail: `${review.inspection.changedPaths.length} dosya incelendi. Kullanıcının ana dalı değişmez.\nSHA-256: ${digest}`,
      buttons: ["Vazgeç", "Onayla ve birleştir"], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return false;
    service.approve(taskId, digest);
    return true;
  });
  handle("mesh:files", (taskId, path = "") => {
    if (typeof taskId !== "string" || typeof path !== "string") throw new Error("Geçersiz dosya isteği");
    return service.files(taskId, path);
  });
  handle("mesh:read-file", (taskId, path) => {
    if (typeof taskId !== "string" || typeof path !== "string") throw new Error("Geçersiz dosya isteği");
    return service.readFile(taskId, path);
  });
  handle("mesh:save-file", (taskId, path, content, digest) => {
    if ([taskId, path, content, digest].some((value) => typeof value !== "string")) throw new Error("Geçersiz kayıt isteği");
    return service.saveFile(taskId as string, path as string, content as string, digest as string);
  });
  handle("mesh:create-task", (task) => service.createTask(task as TaskDraft));
  handle("mesh:save-agent", (agent) => service.saveAgent(agent as AgentConfig));
  handle("mesh:parallelism", (value) => {
    if (typeof value !== "number") throw new Error("Geçersiz paralellik");
    service.setParallelism(value);
  });
  handle("mesh:permission", async (requestId, executionId, digest, decision) => {
    if ([requestId, executionId, digest].some((value) => typeof value !== "string") || !["allow_once", "deny"].includes(String(decision))) throw new Error("Geçersiz izin kararı");
    const request = service.state().permissions.find((item) => item.id === requestId && item.executionId === executionId && item.digest === digest);
    if (!request) throw new Error("İzin isteği artık geçerli değil");
    if (decision === "allow_once") {
      const result = await dialog.showMessageBox(window!, { type: "question", title: "Ajan izni",
        message: `${request.taskId}: bu işleme bir kez izin verilsin mi?`,
        detail: `${request.description}\n\nHassas değerler maskelenmiş olabilir. Kalıcı veya oturum genelinde izin verilmez.`,
        buttons: ["Vazgeç", "Bir kez izin ver"], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    service.decidePermission(requestId as string, executionId as string, digest as string, decision as "allow_once" | "deny");
  });
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  service.subscribe(() => {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (window && !window.isDestroyed()) window.webContents.send("mesh:changed", service.state());
    }, 50);
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { service.openDemo(); void createWindow(); }
  });
}).catch((error) => { console.error(safeLog(String(error))); app.exit(1); });

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  if (window && !window.isDestroyed()) { window.close(); return; }
  quitting = true;
  void service.close().finally(() => app.quit());
});
