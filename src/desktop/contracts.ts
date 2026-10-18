import type { ProjectSnapshot } from "../core/orchestrator.js";
import type { WorktreeInspection } from "../core/worktrees.js";

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
  events: Array<{ at: string; taskId?: string; text: string }>;
}

export interface DesktopAPI {
  state(): Promise<DesktopState>;
  openConfig(): Promise<DesktopState>;
  openDemo(): Promise<DesktopState>;
  start(): Promise<void>;
  cancel(taskId?: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  review(taskId: string): Promise<DesktopReview>;
  approve(taskId: string, digest: string): Promise<boolean>;
  subscribe(listener: (state: DesktopState) => void): () => void;
}
