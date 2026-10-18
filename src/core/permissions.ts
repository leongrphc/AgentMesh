import { createHash, randomUUID } from "node:crypto";
import { safeLog } from "./safe-log.js";
import type { DomainEvent } from "./contracts.js";

export type PermissionDecision = "allow_once" | "deny";
export type PermissionSource = "user" | "timeout" | "cancel" | "disconnect" | "execution_ended" | "restart";
export interface PermissionProposal {
  provider: string;
  sessionId: string;
  nativeRequestId: string;
  kind: "command" | "file";
  description: string;
}
export interface PermissionRequest extends PermissionProposal {
  id: string;
  projectId: string;
  taskId: string;
  executionId: string;
  expiresAt: string;
  digest: string;
}
type Pending = { request: PermissionRequest; settle: (decision: PermissionDecision) => void;
  cleanup: () => void };

/** Pending grants are memory-only. The journal stores scope/digest/decision, never command text. */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<string, Set<string>>();
  constructor(private readonly emit: (event: DomainEvent) => void, private readonly timeoutMs = 120_000) {}

  list(projectId: string): PermissionRequest[] {
    return [...this.pending.values()].filter((entry) => entry.request.projectId === projectId)
      .map((entry) => ({ ...entry.request }));
  }

  request(scope: { projectId: string; taskId: string; executionId: string }, proposal: PermissionProposal, signal: AbortSignal): Promise<PermissionDecision> {
    if (signal.aborted || !["command", "file"].includes(proposal.kind) || !proposal.nativeRequestId
      || !proposal.sessionId || !proposal.provider || typeof proposal.description !== "string"
      || proposal.description.length > 8192) return Promise.resolve("deny");
    const key = JSON.stringify([proposal.provider, proposal.sessionId, proposal.nativeRequestId]);
    const seen = this.seen.get(scope.executionId) ?? new Set<string>();
    if (seen.has(key) || seen.size >= 128) return Promise.resolve("deny");
    seen.add(key); this.seen.set(scope.executionId, seen);
    const request: PermissionRequest = { ...scope, ...proposal, id: randomUUID(),
      description: safeLog(proposal.description),
      digest: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() };
    return new Promise((settle) => {
      const cancel = () => { this.finish(request.id, "deny", "cancel"); };
      const timer = setTimeout(() => { this.finish(request.id, "deny", "timeout"); }, this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      this.pending.set(request.id, { request, settle, cleanup });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.emit({ type: "permission.requested", projectId: scope.projectId, taskId: scope.taskId,
          executionId: scope.executionId, requestId: request.id, provider: proposal.provider,
          kind: proposal.kind, digest: request.digest, expiresAt: request.expiresAt });
      } catch {
        this.pending.delete(request.id); cleanup(); settle("deny");
      }
      if (signal.aborted) cancel();
    });
  }

  decide(projectId: string, requestId: string, executionId: string, digest: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.request.projectId !== projectId || entry.request.executionId !== executionId
      || entry.request.digest !== digest || !["allow_once", "deny"].includes(decision)) throw new Error("Geçersiz veya süresi geçmiş izin kararı");
    if (Date.now() >= Date.parse(entry.request.expiresAt)) {
      this.finish(requestId, "deny", "timeout");
      throw new Error("İzin isteğinin süresi doldu");
    }
    if (!this.finish(requestId, decision, "user")) throw new Error("İzin kararı kaydedilemedi; istek reddedildi");
  }

  closeExecution(executionId: string, source: "disconnect" | "execution_ended"): void {
    for (const entry of [...this.pending.values()]) if (entry.request.executionId === executionId) this.finish(entry.request.id, "deny", source);
    this.seen.delete(executionId);
  }

  private finish(id: string, decision: PermissionDecision, source: PermissionSource): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id); entry.cleanup();
    const { projectId, taskId, executionId } = entry.request;
    try {
      this.emit({ type: "permission.resolved", projectId, taskId, executionId, requestId: id, decision, source });
      entry.settle(decision); return true;
    } catch { entry.settle("deny"); return false; }
  }
}
