import type { ProjectSnapshot } from "../core/orchestrator.js";
import type { WorktreeInspection } from "../core/worktrees.js";
import type { WorkspaceEntry, WorkspaceFile } from "../core/workspace-files.js";
import type { AgentTask } from "../core/contracts.js";

export type TaskDraft = Omit<AgentTask, "projectId">;

export interface DesktopReview {
  taskId: string;
  title: string;
  inspection: WorktreeInspection;
  canApprove: boolean;
  expectedDigest?: string;
}

export interface DesktopState {
  snapshot: ProjectSnapshot;
  busy: boolean;
  demo: boolean;
  agents: Array<{ id: string; provider: string; model?: string }>;
  maxParallel: number;
  events: Array<{ at: string; taskId?: string; text: string }>;
}

export interface DesktopAPI {
  state(): Promise<DesktopState>;
  openConfig(): Promise<DesktopState>;
  openDemo(): Promise<DesktopState>;
  start(): Promise<void>;
  cancel(taskId?: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  review(taskId: string, refresh?: boolean): Promise<DesktopReview>;
  approve(taskId: string, digest: string): Promise<boolean>;
  files(taskId: string, path?: string): Promise<{ root: string; entries: WorkspaceEntry[] }>;
  readFile(taskId: string, path: string): Promise<WorkspaceFile>;
  saveFile(taskId: string, path: string, content: string, digest: string): Promise<WorkspaceFile>;
  createTask(task: TaskDraft): Promise<void>;
  setParallelism(value: number): Promise<void>;
  subscribe(listener: (state: DesktopState) => void): () => void;
}
