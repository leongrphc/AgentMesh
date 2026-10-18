import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { DesktopService } from "./service.js";
import { safeLog } from "../core/safe-log.js";

protocol.registerSchemesAsPrivileged([{ scheme: "agentmesh", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const origin = "agentmesh://desktop";
const smoke = process.argv.includes("--smoke-test");
let window: BrowserWindow | undefined;
let service: DesktopService;
let quitting = false;

async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 950, minWidth: 960, minHeight: 640,
    show: !smoke, backgroundColor: "#17222d", title: "AgentMesh",
    webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: !smoke },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL(`${origin}/index.html`);
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
      await window.webContents.executeJavaScript(`document.querySelector('[data-testid="start"]').click()`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Demo ekranı tamamlanmadı')), 15000);
        const check = setInterval(() => { if (document.querySelectorAll('.task-row .status.completed').length === 4
          && document.querySelector('[data-testid="start"]').textContent.includes('Ajanları başlat')) {
          clearInterval(check); clearTimeout(timeout); resolve(true);
        } }, 50);
      })`);
      if (!service.state().snapshot.tasks.every((task) => task.status === "completed")) throw new Error("Demo tamamlanmadı");
      const root = resolve("dist");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "desktop-smoke.png"), (await window.capturePage()).toPNG());
      console.log("Desktop smoke başarılı: sandbox, preload, React ve demo görevleri doğrulandı");
      app.quit();
    } catch (error) { console.error(error); await service.close(); app.exit(1); }
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
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  service.subscribe(() => {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (window && !window.isDestroyed()) window.webContents.send("mesh:changed", service.state());
    }, 50);
  });
  await createWindow();
  window!.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window!.webContents.session.setPermissionCheckHandler(() => false);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => { console.error(safeLog(String(error))); app.exit(1); });

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  void service.close().finally(() => app.quit());
});
