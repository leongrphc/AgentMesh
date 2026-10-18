import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { DesktopAPI } from "../src/desktop/contracts.js";
import type { TerminalInfo } from "../src/desktop/terminals.js";
import "@xterm/xterm/css/xterm.css";

function TerminalView({ info, api, visible }: { info: TerminalInfo; api: DesktopAPI; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    const terminal = new Terminal({ fontFamily: "Consolas, monospace", fontSize: 13, scrollback: 2000,
      theme: { background: "#121d27", foreground: "#d8e4ee", cursor: "#78d2c6" }, allowProposedApi: false });
    const fit = new FitAddon(); fitRef.current = fit;
    terminal.loadAddon(fit); terminal.open(host.current!);
    let live = true, offset = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (e: unknown) => { if (live) setError(String(e)); };
    let writes = Promise.resolve();
    const input = terminal.onData((data) => {
      for (let start = 0; start < data.length; start += 8192) {
        const chunk = data.slice(start, start + 8192);
        writes = writes.then(() => api.terminalWrite(info.id, chunk)).catch(fail);
      }
    });
    const resize = terminal.onResize(({ cols, rows }) => { void api.terminalResize(info.id, cols, rows).catch(fail); });
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth) fit.fit(); });
    observer.observe(host.current!);
    async function poll() {
      try {
        const result = await api.terminalRead(info.id, offset);
        if (!live) return;
        if (result.truncated) terminal.write("\r\n[Eski çıktı tampon sınırını aştı]\r\n");
        if (result.data) await new Promise<void>((resolve) => terminal.write(result.data, resolve));
        offset = result.offset;
        if (!live) return;
        if (result.exitCode !== undefined) {
          terminal.write(`\r\n[Süreç sonlandı: ${result.exitCode}]\r\n`);
          terminal.options.disableStdin = true;
        } else timer = setTimeout(() => { void poll(); }, 100);
      } catch (e) { fail(e); }
    }
    void poll();
    return () => { live = false; clearTimeout(timer); observer.disconnect(); input.dispose(); resize.dispose(); terminal.dispose(); fitRef.current = undefined; };
  }, [api, info.id]);
  useEffect(() => { if (visible) fitRef.current?.fit(); }, [visible]);
  return <div hidden={!visible}><div className="terminal-screen" ref={host} />{error && <p role="alert" className="task-error">{error}</p>}</div>;
}

export function TerminalPanel({ api, taskId, available, busy }: { api: DesktopAPI; taskId?: string; available: boolean; busy: boolean }) {
  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function open() {
    setPending(true); setError("");
    try { const info = await api.terminalOpen(taskId!, 100, 24); setTabs((old) => [...old, info]); setSelected(info.id); }
    catch (e) { setError(String(e)); } finally { setPending(false); }
  }
  async function close(id: string) {
    setError("");
    try { await api.terminalClose(id); setTabs((old) => old.filter((t) => t.id !== id)); }
    catch (e) { setError(String(e)); }
  }
  const active = tabs.some((t) => t.id === selected) ? selected : tabs[0]?.id;
  return <section className="terminal-panel" aria-label="Görev terminalleri">
    <div className="section-heading"><h2>Terminal <span>{tabs.length} / 4</span></h2><button data-testid="terminal-open" disabled={!taskId || !available || busy || pending || tabs.length >= 4} onClick={() => void open()}>＋ Terminal aç</button></div>
    <p className="terminal-note">{available ? "Seçili görevde kullanıcı kabuğu. Komutlar hesabınızın yetkileriyle çalışır; dosya kapsamı sınırı uygulanmaz. Ajanları başlatmadan veya birleştirmeden önce terminalleri kapatın." : "Terminal açmak için durdurulmuş bir görev worktree’si seçin."}</p>
    {error && <p className="task-error" role="alert">{error}</p>}
    <div className="terminal-tabs" role="tablist" aria-label="Açık terminaller">{tabs.map((info) => <div key={info.id} data-terminal-id={info.id}><button role="tab" aria-selected={active === info.id} onClick={() => setSelected(info.id)} title={info.cwd}>{info.taskId}</button><button aria-label={`${info.taskId} terminalini kapat`} data-testid="terminal-close" onClick={() => void close(info.id)}>×</button></div>)}</div>
    {tabs.map((info) => <TerminalView key={info.id} info={info} api={api} visible={active === info.id} />)}
    {!tabs.length && <p className="empty">Komutları çalıştırmak için terminal açın. Çıktı yalnızca bu oturumda tutulur.</p>}
    {tabs.find((t) => t.id === active) && <code className="terminal-cwd">{tabs.find((t) => t.id === active)!.cwd}</code>}
  </section>;
}
