import type { PermissionDecision, PermissionProposal, PermissionSource } from "./permissions.js";
import type { AgentConfig } from "./config.js";
import type { MergeConflict } from "./worktrees.js";
/** Provider bağımsız dahili sözleşmeler. ACP veya MCP wire formatı değildir. */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "pending_review"
  | "cancelled"
  | "needs_review";

export interface AgentTask {
  id: string;
  projectId: string;
  title: string;
  instruction: string;
  agentId: string;
  dependsOn: string[];
  /** Daha sonra worktree/izin sınırlarına bağlanacak dosya yolları. */
  allowedPaths: string[];
}

export interface Fact {
  key: string;
  value: string;
  sourceTaskId: string;
  updatedAt: string;
  revision?: number;
}

export type ContextChoice = "keep" | "accept" | "custom";
export interface ContextConflict {
  id: string;
  key: string;
  proposal: Fact;
  baseRevision: number;
  status: "pending" | "resolved";
  resolution?: { choice: ContextChoice; revision: number; at: string };
}

export interface AgentMessage {
  id: string;
  projectId: string;
  taskId: string;
  from: string;
  to: string;
  kind: "handoff" | "question" | "progress";
  body: string;
  createdAt: string;
  idempotencyKey?: string;
}

export interface MessageDraft {
  to: string;
  kind: "question" | "progress";
  body: string;
  idempotencyKey: string;
}
export interface MessageDelivery {
  taskId: string;
  messageId: string;
  executionId: string;
  status: "sending" | "accepted" | "queued" | "uncertain";
  mode: "prompt" | "live";
}

export interface AgentExecution {
  task: AgentTask;
  workspaceRoot: string;
  context: Readonly<Record<string, Fact>>;
  inbox: ReadonlyArray<AgentMessage>;
  knownAgentIds?: readonly string[];
  agentRole?: string;
  liveMessages?: boolean;
  sendMessage?: (message: MessageDraft) => string;
  acknowledgeInbox?: () => void;
  subscribeInbox?: (handler: (message: AgentMessage) => Promise<boolean>) => () => Promise<void>;
  sessionId?: string;
  onSession?: (sessionId: string) => void;
  signal?: AbortSignal;
  onOutput?: (output: AgentOutput) => void;
  requestPermission?: (proposal: PermissionProposal, signal?: AbortSignal) => Promise<PermissionDecision>;
}

/** Transient CLI output; consumers must redact secrets before exporting logs. */
export type AgentOutput =
  | { channel: "stdout"; data: Record<string, unknown> }
  | { channel: "stderr"; data: string };

export interface AgentResult {
  summary: string;
  sessionId?: string;
  facts?: ReadonlyArray<{ key: string; value: string }>;
  messages?: ReadonlyArray<Pick<AgentMessage, "to" | "kind" | "body">>;
  tests?: TestReport[];
}

/** Agent-reported evidence, never an independent verification by AgentMesh. */
export interface TestReport {
  name: string;
  status: "passed" | "failed" | "not_run";
  command?: string;
  details?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  readonly connection: "cli" | "api" | "mock";
  readonly interactivePermissions?: boolean;
  readonly liveMessages?: boolean;
  execute(input: AgentExecution): Promise<AgentResult>;
}

export interface Project {
  id: string;
  workspaceRoot: string;
  maxParallel?: number;
}

export interface TaskRecord extends AgentTask {
  status: TaskStatus;
  summary?: string;
  error?: string;
  sessionId?: string;
  worktree?: { path: string; branch: string; baseCommit?: string };
  mergeConflict?: MergeConflict;
  review?: { digest: string; result: AgentResult };
  integratedCommit?: string;
  tests?: TestReport[];
  testDigest?: string;
}

export type DomainEvent =
  | { type: "project.created"; project: Project }
  | { type: "project.agents.configured"; projectId: string; agents: AgentConfig[]; sourceAgents: AgentConfig[] }
  | { type: "message.delivery"; projectId: string; delivery: MessageDelivery }
  | { type: "project.parallelism.updated"; projectId: string; maxParallel: number }
  | { type: "permission.requested"; projectId: string; taskId: string; executionId: string; requestId: string; provider: string; kind: "command" | "file"; digest: string; expiresAt: string }
  | { type: "permission.resolved"; projectId: string; taskId: string; executionId: string; requestId: string; decision: PermissionDecision; source: PermissionSource }
  | { type: "task.created"; task: AgentTask }
  | { type: "task.started"; projectId: string; taskId: string }
  | { type: "task.completed"; projectId: string; taskId: string; summary: string; tests?: TestReport[] }
  | { type: "task.failed"; projectId: string; taskId: string; error: string }
  | { type: "task.blocked"; projectId: string; taskId: string }
  | { type: "task.interrupted"; projectId: string; taskId: string }
  | { type: "task.cancelled"; projectId: string; taskId: string }
  | { type: "task.retried"; projectId: string; taskId: string }
  | { type: "task.session.saved"; projectId: string; taskId: string; sessionId: string }
  | { type: "task.worktree.prepared"; projectId: string; taskId: string; path: string; branch: string; baseCommit?: string }
  | { type: "task.merge.conflicted"; projectId: string; taskId: string; conflict: MergeConflict }
  | { type: "task.merge.prepared"; projectId: string; taskId: string; baseCommit: string }
  | { type: "task.review.requested"; projectId: string; taskId: string; digest: string; result: AgentResult; testDigest?: string }
  | { type: "task.review.approved"; projectId: string; taskId: string; digest: string; commit: string }
  | { type: "context.updated"; projectId: string; fact: Fact }
  | { type: "context.conflict.created"; projectId: string; conflict: ContextConflict }
  | { type: "context.conflict.resolved"; projectId: string; conflictId: string; choice: ContextChoice; revision: number; at: string }
  | { type: "message.sent"; projectId: string; message: AgentMessage };

export interface StoredEvent {
  id: string;
  at: string;
  payload: DomainEvent;
}
