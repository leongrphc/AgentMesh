import type { ProjectSnapshot } from "../core/orchestrator.js";
import type { WorktreeInspection } from "../core/worktrees.js";
import type { ConflictFile, WorkspaceEntry, WorkspaceFile } from "../core/workspace-files.js";
import type { AgentTask, TestReport, MessageDraft } from "../core/contracts.js";
import type { PermissionRequest, PermissionDecision } from "../core/permissions.js";
import type { ProviderHealth } from "../adapters/provider-health.js";
import type { TerminalInfo, TerminalOutput } from "./terminals.js";
import type { ProviderMessageInput, ProviderMessageResult } from "../adapters/provider-message.js";
import type { AgentConfig } from "../core/config.js";

export type TaskDraft = Omit<AgentTask, "projectId">;

export interface DesktopReview {
  taskId: string;
  title: string;
  inspection: WorktreeInspection;
  canApprove: boolean;
  expectedDigest?: string;
  tests?: TestReport[];
  testsStale?: boolean;
  merge?: { paths: string[]; integrationCommit: string; active: boolean; unresolved: string[] };
}

export interface DesktopState {
  snapshot: ProjectSnapshot;
  busy: boolean;
  demo: boolean;
  agents: Array<AgentConfig & { interactivePermissions?: boolean; liveMessages?: boolean }>;
  permissions: PermissionRequest[];
  health: Record<string, ProviderHealth>;
  checkingAgents: boolean;
  testingProvider?: string;
  maxParallel: number;
  events: Array<{ at: string; taskId?: string; text: string }>;
}

export interface DesktopAPI {
  sendMessage(message: MessageDraft): Promise<string>;
  openProviderTerminal(model?: string): Promise<TerminalInfo>;
  testProvider(input: ProviderMessageInput): Promise<ProviderMessageResult>;
  cancelProviderTest(): Promise<void>;
  terminalOpen(taskId: string, cols: number, rows: number): Promise<TerminalInfo>;
  terminalRead(id: string, offset: number): Promise<TerminalOutput>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalClose(id: string): Promise<void>;
  state(): Promise<DesktopState>;
  openConfig(): Promise<DesktopState>;
  openDemo(): Promise<DesktopState>;
  start(): Promise<void>;
  cancel(taskId?: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  review(taskId: string, refresh?: boolean): Promise<DesktopReview>;
  prepareMergeResolution(taskId: string, digest: string, integrationCommit: string): Promise<DesktopReview>;
  conflictFile(taskId: string, path: string): Promise<ConflictFile>;
  resolveConflict(taskId: string, path: string, content: string | null, digest: string | null, keepCurrent?: boolean): Promise<DesktopReview>;
  approve(taskId: string, digest: string): Promise<boolean>;
  files(taskId: string, path?: string): Promise<{ root: string; writable: boolean; entries: WorkspaceEntry[] }>;
  createEntry(taskId: string, path: string, directory: boolean): Promise<WorkspaceEntry>;
  readFile(taskId: string, path: string): Promise<WorkspaceFile>;
  saveFile(taskId: string, path: string, content: string, digest: string): Promise<WorkspaceFile>;
  createTask(task: TaskDraft): Promise<void>;
  saveAgent(agent: AgentConfig): Promise<void>;
  setParallelism(value: number): Promise<void>;
  decidePermission(requestId: string, executionId: string, digest: string, decision: PermissionDecision): Promise<void>;
  checkAgents(): Promise<void>;
  subscribe(listener: (state: DesktopState) => void): () => void;
}
