/** Provider bağımsız dahili sözleşmeler. ACP veya MCP wire formatı değildir. */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
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
}

export interface AgentExecution {
  task: AgentTask;
  workspaceRoot: string;
  context: Readonly<Record<string, Fact>>;
  inbox: ReadonlyArray<AgentMessage>;
  sessionId?: string;
}

export interface AgentResult {
  summary: string;
  sessionId?: string;
  facts?: ReadonlyArray<{ key: string; value: string }>;
  messages?: ReadonlyArray<Pick<AgentMessage, "to" | "kind" | "body">>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  readonly connection: "cli" | "api" | "mock";
  execute(input: AgentExecution): Promise<AgentResult>;
}

export interface Project {
  id: string;
  workspaceRoot: string;
}

export interface TaskRecord extends AgentTask {
  status: TaskStatus;
  summary?: string;
  error?: string;
  sessionId?: string;
  worktree?: { path: string; branch: string };
}

export type DomainEvent =
  | { type: "project.created"; project: Project }
  | { type: "task.created"; task: AgentTask }
  | { type: "task.started"; projectId: string; taskId: string }
  | { type: "task.completed"; projectId: string; taskId: string; summary: string }
  | { type: "task.failed"; projectId: string; taskId: string; error: string }
  | { type: "task.blocked"; projectId: string; taskId: string }
  | { type: "task.interrupted"; projectId: string; taskId: string }
  | { type: "task.retried"; projectId: string; taskId: string }
  | { type: "task.session.saved"; projectId: string; taskId: string; sessionId: string }
  | { type: "task.worktree.prepared"; projectId: string; taskId: string; path: string; branch: string }
  | { type: "context.updated"; projectId: string; fact: Fact }
  | { type: "message.sent"; projectId: string; message: AgentMessage };

export interface StoredEvent {
  id: string;
  at: string;
  payload: DomainEvent;
}
