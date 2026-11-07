import type { ProjectSnapshot } from "../core/orchestrator.js";
import type { WorktreeInspection } from "../core/worktrees.js";
import type { ConflictFile, WorkspaceEntry, WorkspaceFile } from "../core/workspace-files.js";
import type { AgentTask, TestReport, MessageDraft, ContextChoice } from "../core/contracts.js";
import type { PermissionRequest, PermissionDecision } from "../core/permissions.js";
import type { ProviderHealth } from "../adapters/provider-health.js";
import type { TerminalInfo, TerminalOutput } from "./terminals.js";
import type { ProviderMessageInput, ProviderMessageResult } from "../adapters/provider-message.js";
import type { AgentConfig } from "../core/config.js";
import type { RecentProject } from "./folder-project.js";

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
  historyCounts: { resolvedDecisions: number; contextPackages: Record<string, number>; messages: number; messageRevision: string };
  snapshot: ProjectSnapshot;
  busy: boolean;
  demo: boolean;
  /** How the current project was opened. */
  source: "demo" | "folder" | "config";
  recent: RecentProject[];
  /** Uncommitted changes in the repository are invisible to agents, which start from HEAD. */
  uncommittedChanges: boolean;
  /** A planner agent is currently drafting tasks. */
  planning: boolean;
  /** Codex accounts found under ~/.codex-profiles, selectable per Codex agent. */
  codexProfiles: Array<{ name: string; path: string }>;
  /** Approved commits on the integration branch that the user's checked-out branch does not have yet. */
  integrationPending: number;
  /** What opening the project changed, e.g. a Git repository was created for the folder. */
  openNotice?: string;
  /** Branch that receives approved changes (absent for the demo). */
  integrationBranch?: string;
  /** File scope suggested for new tasks. */
  defaultAllowedPaths: string[];
  agents: Array<AgentConfig & { interactivePermissions?: boolean; liveMessages?: boolean }>;
  permissions: PermissionRequest[];
  health: Record<string, ProviderHealth>;
  checkingAgents: boolean;
  testingProvider?: string;
  maxParallel: number;
  events: Array<{ at: string; taskId?: string; text: string }>;
}

export interface DesktopAPI {
  messageHistory(projectId: string, workspaceRoot: string, taskId?: string, before?: number): Promise<import("../core/contracts.js").HistoryPage<import("../core/contracts.js").MessageHistoryEntry>>;
  resolvedContext(projectId: string, workspaceRoot: string, before?: number): Promise<import("../core/contracts.js").HistoryPage<import("../core/contracts.js").ContextConflict>>;
  contextPackages(projectId: string, workspaceRoot: string, taskId: string, before?: number): Promise<import("../core/contracts.js").HistoryPage<import("../core/contracts.js").ContextPackage>>;
  contextHistory(projectId: string, workspaceRoot: string, key: string, before?: number): Promise<import("../core/contracts.js").ContextHistoryPage>;
  resolveContext(conflictId: string, revision: number, choice: ContextChoice, value?: string): Promise<void>;
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
  openFolder(): Promise<DesktopState>;
  openRecent(path: string): Promise<DesktopState>;
  /** Merges approved work into the checked-out branch. */
  applyIntegration(): Promise<{ branch: string; commits: number; fastForward: boolean; cleaned: number }>;
  start(): Promise<void>;
  cancel(taskId?: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  reassign(taskId: string, agentId: string): Promise<void>;
  requestChanges(taskId: string, feedback: string): Promise<void>;
  reviewFile(taskId: string, path: string): Promise<{ path: string; original: string | null; modified: string | null; skipped?: "binary" | "large" }>;
  planTasks(goal: string, agentId: string): Promise<TaskDraft[]>;
  cancelPlan(): Promise<void>;
  updateSettings(settings: import("../core/contracts.js").ProjectSettings): Promise<void>;
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
