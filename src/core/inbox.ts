import type { AgentMessage, MessageDraft } from "./contracts.js";

export function validateMessageDraft(value: MessageDraft, recipients: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.to !== "string" || (value.to !== "*" && !recipients.includes(value.to))
    || !["progress", "question"].includes(value.kind)
    || typeof value.body !== "string" || !value.body.trim() || value.body.length > 16384
    || typeof value.idempotencyKey !== "string" || !/^[\w.-]{1,200}$/.test(value.idempotencyKey)) {
    throw new Error("Geçersiz mesaj, alıcı veya tekrar önleme anahtarı");
  }
}

/** One ordered delivery at a time; uncertainty is retained, never silently acknowledged. */
export class ExecutionInbox {
  private handler?: (message: AgentMessage) => Promise<boolean>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly options: {
    pending: () => AgentMessage[];
    active: () => boolean;
    record: (messageId: string, status: "sending" | "accepted" | "queued" | "uncertain") => void;
    onError: (error: unknown) => void;
    signal: AbortSignal;
    timeoutMs?: number;
  }) {}

  subscribe(handler: (message: AgentMessage) => Promise<boolean>): () => Promise<void> {
    if (this.handler || this.stopped) throw new Error("Inbox aboneliği zaten açık veya kapalı");
    this.handler = handler;
    this.wake();
    return () => this.close();
  }

  wake(): void {
    if (this.running || this.stopped || !this.handler || !this.options.active()) return;
    this.running = Promise.resolve().then(() => this.pump()).catch((error: unknown) => {
      this.stopped = true; this.options.onError(error);
    }).finally(() => {
      this.running = undefined;
      if (!this.stopped && this.handler && this.options.active() && this.options.pending().length) this.wake();
    });
  }

  private async pump() {
    while (!this.stopped && this.handler && this.options.active()) {
      const message = this.options.pending()[0];
      if (!message) return;
      this.options.record(message.id, "sending");
      let status: "accepted" | "queued" | "uncertain";
      const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30000)]);
      let abort!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Inbox teslimi kesildi"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      try { status = await Promise.race([this.handler(structuredClone(message)), interrupted]) ? "accepted" : "queued"; }
      catch { status = "uncertain"; }
      finally { signal.removeEventListener("abort", abort); }
      if (!this.options.active()) status = "uncertain";
      this.options.record(message.id, status);
      if (status !== "accepted") { this.stopped = true; return; }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.running;
    this.handler = undefined;
  }
}
