import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopState } from "./contracts.js";

const api: DesktopAPI = {
  state: () => ipcRenderer.invoke("mesh:state"),
  openConfig: () => ipcRenderer.invoke("mesh:open"),
  openDemo: () => ipcRenderer.invoke("mesh:demo"),
  start: () => ipcRenderer.invoke("mesh:start"),
  cancel: (taskId) => ipcRenderer.invoke("mesh:cancel", taskId),
  retry: (taskId) => ipcRenderer.invoke("mesh:retry", taskId),
  review: (taskId, refresh) => ipcRenderer.invoke("mesh:review", taskId, refresh),
  approve: (taskId, digest) => ipcRenderer.invoke("mesh:approve", taskId, digest),
  files: (taskId, path) => ipcRenderer.invoke("mesh:files", taskId, path),
  readFile: (taskId, path) => ipcRenderer.invoke("mesh:read-file", taskId, path),
  saveFile: (taskId, path, content, digest) => ipcRenderer.invoke("mesh:save-file", taskId, path, content, digest),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on("mesh:changed", handler);
    return () => { ipcRenderer.removeListener("mesh:changed", handler); };
  },
};
contextBridge.exposeInMainWorld("agentmesh", api);
