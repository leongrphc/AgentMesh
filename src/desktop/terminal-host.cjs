// Private PTY host, usable by Electron's Node mode and standalone test Node.
const { spawn } = require("node-pty");
let pty, ending = false;
function exit(code) {
  if (ending) return;
  ending = true;
  process.send?.({ type: "exit", code }, () => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on("message", (message) => {
  try {
    if (message.type === "start" && !pty) {
      const win = process.platform === "win32";
      pty = spawn(win ? process.env.ComSpec || "cmd.exe" : "/bin/sh", win ? ["/d", "/q"] : [], {
        cwd: message.cwd, cols: message.cols, rows: message.rows,
        name: "xterm-256color", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, TERM: "xterm-256color" },
      });
      pty.onData((data) => {
        if (ending || !process.connected) return;
        if (!process.send({ type: "data", data }, () => { if (!ending) pty.resume(); })) pty.pause();
      });
      pty.onExit(({ exitCode }) => exit(exitCode ?? -1));
      process.send({ type: "ready" });
    } else if (message.type === "write" && pty && !ending) pty.write(message.data);
    else if (message.type === "resize" && pty && !ending) pty.resize(message.cols, message.rows);
    else if (message.type === "close" && pty && !ending) pty.kill();
  } catch {
    process.send?.({ type: "error" });
    if (pty && !ending) { try { pty.kill(); } catch {} }
    exit(-1);
  }
});
process.on("disconnect", () => {
  if (pty && !ending) { try { pty.kill(); } catch {} }
  process.exit(1);
});
