import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface TerminalInfo { id: string; taskId: string; cwd: string; exitCode?: number }
export interface TerminalOutput { data: string; offset: number; truncated: boolean; exitCode?: number }
interface Session { info: TerminalInfo; child: ChildProcess; data: string; offset: number; done: Promise<void> }

// Dedicated hosts keep native ConPTY workers out of the desktop process.
// Output stays in bounded memory and is never written to the journal.
export class Terminals {
  private readonly sessions = new Map<string, Session>();
  get count() { return this.sessions.size; }
  get active() { return [...this.sessions.values()].some((s) => s.info.exitCode === undefined); }
  async open(taskId: string, cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    this.dimensions(cols, rows);
    if (this.sessions.size >= 4) throw new Error("En fazla dört terminal açılabilir");
    const child = fork(join(import.meta.dirname ?? __dirname, "terminal-host.cjs"), [], {
      execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const s: Session = { info: { id: randomUUID(), taskId, cwd }, child, data: "", offset: 0, done };
    this.sessions.set(s.info.id, s);
    let nativeExit: number | undefined;
    child.on("message", (message: { type: string; data?: string; code?: number }) => {
      if (message.type === "data" && typeof message.data === "string") {
        s.data = (s.data + message.data).slice(-131072); s.offset += message.data.length;
      } else if (message.type === "exit") nativeExit = message.code;
    });
    child.once("exit", (code) => { s.info.exitCode = nativeExit ?? code ?? -1; finished(); });
    child.once("error", () => { s.info.exitCode = -1; finished(); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Terminal açılışı zaman aşımına uğradı")), 10000);
        const message = (value: { type: string }) => { if (value.type === "ready") finish(); else if (value.type === "error") finish(new Error("Yerel terminal başlatılamadı")); };
        const exit = () => finish(new Error("Terminal açılışta sonlandı"));
        const finish = (error?: Error) => {
          clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", finish);
          if (error) reject(error); else resolve();
        };
        child.on("message", message); child.once("exit", exit); child.once("error", finish);
        child.send({ type: "start", cwd, cols, rows }, (error) => { if (error) finish(error); });
      });
      return { ...s.info };
    } catch (error) { child.kill(); await done; this.sessions.delete(s.info.id); throw error; }
  }
  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Terminal artık açık değil");
    return session;
  }
  read(id: string, offset: number): TerminalOutput {
    const s = this.session(id);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > s.offset) throw new Error("Geçersiz terminal konumu");
    const start = s.offset - s.data.length;
    return { data: s.data.slice(Math.max(0, offset - start)), offset: s.offset, truncated: offset < start, exitCode: s.info.exitCode };
  }
  private send(id: string, message: object) {
    const s = this.session(id);
    if (s.info.exitCode !== undefined || !s.child.connected) throw new Error("Terminal süreci sonlandı");
    s.child.send(message, () => {});
  }
  write(id: string, data: string) {
    if (typeof data !== "string" || data.length > 8192) throw new Error("Terminal girdisi en fazla 8192 karakter olabilir");
    this.send(id, { type: "write", data });
  }
  resize(id: string, cols: number, rows: number) {
    this.dimensions(cols, rows);
    if (this.session(id).info.exitCode === undefined) this.send(id, { type: "resize", cols, rows });
  }
  private dimensions(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 200)
      throw new Error("Geçersiz terminal boyutu");
  }
  async close(id: string) {
    const s = this.session(id);
    if (s.info.exitCode === undefined) {
      this.send(id, { type: "close" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([s.done, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Terminal kapanışı zaman aşımına uğradı; yeniden kapatmayı deneyin")), 10000);
        })]);
      } finally { clearTimeout(timer); }
    }
    this.sessions.delete(id);
  }
  async closeAll() { await Promise.all([...this.sessions.keys()].map((id) => this.close(id))); }
}
