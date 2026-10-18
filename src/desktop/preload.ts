import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopState } from "./contracts.js";

const api: DesktopAPI = {
  state: () => ipcRenderer.invoke("mesh:state"),
  openConfig: () => ipcRenderer.invoke("mesh:open"),
  openDemo: () => ipcRenderer.invoke("mesh:demo"),
  start: () => ipcRenderer.invoke("mesh:start"),
  cancel: (taskId) => ipcRenderer.invoke("mesh:cancel", taskId),
  retry: (taskId) => ipcRenderer.invoke("mesh:retry", taskId),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on("mesh:changed", handler);
    return () => { ipcRenderer.removeListener("mesh:changed", handler); };
  },
};
contextBridge.exposeInMainWorld("agentmesh", api);
