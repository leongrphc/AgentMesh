/**
 * Renders the AgentMesh mark (two lines meeting at one stop) into build/icon.png and a multi-size
 * build/icon.ico. Run with Electron so no image libraries are needed: npm run icon
 */
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="14" fill="#171a23"/>
  <path d="M17 13 C17 32, 32 28, 32 50" fill="none" stroke="#e59a5b" stroke-width="6.5" stroke-linecap="round"/>
  <path d="M47 13 C47 32, 32 28, 32 50" fill="none" stroke="#4fc1d6" stroke-width="6.5" stroke-linecap="round"/>
  <circle cx="32" cy="50" r="6.5" fill="#171a23" stroke="#e7e9f0" stroke-width="5"/>
</svg>`;

/** ICO container holding PNG images (supported by Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = join(__dirname, "..", "build");
  mkdirSync(out, { recursive: true });
  // Render once at full size; smaller icons are high-quality downscales of the same image.
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(256)}</body></html>`)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  win.destroy();
  const images = [256, 128, 64, 48, 32, 24, 16].map((size) => ({ size,
    png: (size === 256 ? full : full.resize({ width: size, height: size, quality: "best" })).toPNG() }));
  writeFileSync(join(out, "icon.png"), images[0].png);
  writeFileSync(join(out, "icon.ico"), ico(images));
  console.log(`build/icon.ico (${images.map((image) => image.size).join(", ")} px)`);
  app.quit();
});
