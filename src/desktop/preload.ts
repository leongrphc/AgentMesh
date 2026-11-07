import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopState } from "./contracts.js";

const api: DesktopAPI = {
  sendMessage: (message) => ipcRenderer.invoke("mesh:send-message", message),
  resolveContext: (id, revision, choice, value) => ipcRenderer.invoke("mesh:resolve-context", id, revision, choice, value),
  contextHistory: (projectId, workspaceRoot, key, before) => ipcRenderer.invoke("mesh:context-history", projectId, workspaceRoot, key, before),
  messageHistory: (projectId, workspaceRoot, taskId, before) => ipcRenderer.invoke("mesh:message-history", projectId, workspaceRoot, taskId, before),
  resolvedContext: (projectId, workspaceRoot, before) => ipcRenderer.invoke("mesh:resolved-context", projectId, workspaceRoot, before),
  contextPackages: (projectId, workspaceRoot, taskId, before) => ipcRenderer.invoke("mesh:context-packages", projectId, workspaceRoot, taskId, before),
  openProviderTerminal: (model) => ipcRenderer.invoke("mesh:provider-terminal", model),
  testProvider: (input) => ipcRenderer.invoke("mesh:test-provider", input),
  cancelProviderTest: () => ipcRenderer.invoke("mesh:cancel-provider-test"),
  terminalOpen: (taskId, cols, rows) => ipcRenderer.invoke("mesh:terminal-open", taskId, cols, rows),
  terminalRead: (id, offset) => ipcRenderer.invoke("mesh:terminal-read", id, offset),
  terminalWrite: (id, data) => ipcRenderer.invoke("mesh:terminal-write", id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke("mesh:terminal-resize", id, cols, rows),
  terminalClose: (id) => ipcRenderer.invoke("mesh:terminal-close", id),
  state: () => ipcRenderer.invoke("mesh:state"),
  openConfig: () => ipcRenderer.invoke("mesh:open"),
  openDemo: () => ipcRenderer.invoke("mesh:demo"),
  openFolder: () => ipcRenderer.invoke("mesh:open-folder"),
  openRecent: (path) => ipcRenderer.invoke("mesh:open-recent", path),
  applyIntegration: () => ipcRenderer.invoke("mesh:apply-integration"),
  start: () => ipcRenderer.invoke("mesh:start"),
  cancel: (taskId) => ipcRenderer.invoke("mesh:cancel", taskId),
  retry: (taskId) => ipcRenderer.invoke("mesh:retry", taskId),
  reassign: (taskId, agentId) => ipcRenderer.invoke("mesh:reassign", taskId, agentId),
  review: (taskId, refresh) => ipcRenderer.invoke("mesh:review", taskId, refresh),
  prepareMergeResolution: (taskId, digest, integrationCommit) => ipcRenderer.invoke("mesh:prepare-merge", taskId, digest, integrationCommit),
  conflictFile: (taskId, path) => ipcRenderer.invoke("mesh:conflict-file", taskId, path),
  resolveConflict: (taskId, path, content, digest, keepCurrent) => ipcRenderer.invoke("mesh:resolve-conflict", taskId, path, content, digest, keepCurrent),
  approve: (taskId, digest) => ipcRenderer.invoke("mesh:approve", taskId, digest),
  files: (taskId, path) => ipcRenderer.invoke("mesh:files", taskId, path),
  createEntry: (taskId, path, directory) => ipcRenderer.invoke("mesh:create-entry", taskId, path, directory),
  readFile: (taskId, path) => ipcRenderer.invoke("mesh:read-file", taskId, path),
  saveFile: (taskId, path, content, digest) => ipcRenderer.invoke("mesh:save-file", taskId, path, content, digest),
  createTask: (task) => ipcRenderer.invoke("mesh:create-task", task),
  saveAgent: (agent) => ipcRenderer.invoke("mesh:save-agent", agent),
  setParallelism: (value) => ipcRenderer.invoke("mesh:parallelism", value),
  decidePermission: (requestId, executionId, digest, decision) => ipcRenderer.invoke("mesh:permission", requestId, executionId, digest, decision),
  checkAgents: () => ipcRenderer.invoke("mesh:check-agents"),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on("mesh:changed", handler);
    return () => { ipcRenderer.removeListener("mesh:changed", handler); };
  },
};
contextBridge.exposeInMainWorld("agentmesh", api);
