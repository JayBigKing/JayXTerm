const os = require("node:os");
const { discoverShellProfiles } = require("./local-shells.cjs");

const highWater = 256 * 1024;
const lowWater = 64 * 1024;
const validSize = (value) => Number.isInteger(value) && value > 0 && value <= 1000;

function installLocalTerminals({ ipcMain, isWorkspace, settings }) {
  const sessions = new Map();
  let discovery;
  let discoveryUntil = 0;

  function profiles() {
    if (Date.now() >= discoveryUntil) {
      discoveryUntil = Infinity;
      discovery = discoverShellProfiles().finally(() => { discoveryUntil = Date.now() + 5000; });
    }
    return discovery;
  }

  function assertWorkspace(event) {
    const { sender, senderFrame } = event;
    if (sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame || !isWorkspace(sender.id))
      throw new Error("此操作仅适用于当前工作窗口");
  }

  function close(id, session) {
    sessions.delete(id);
    session.data?.dispose();
    session.exit?.dispose();
    if (session.terminal) {
      try {
        if (session.paused) session.terminal.resume();
        session.terminal.kill();
      }
      catch { /* The process may have already stopped. */ }
    }
  }

  ipcMain.handle("local-terminal:profiles", async (event) => {
    assertWorkspace(event);
    const available = await profiles();
    const preferred = settings.getLocalShellProfile();
    const automatic = available[0]?.id ?? "";
    return {
      available: available.map(({ id, name }) => ({ id, name })),
      preferred,
      selected: available.find(({ id }) => id === preferred)?.id || automatic,
    };
  });

  ipcMain.handle("local-terminal:default", async (event, id) => {
    assertWorkspace(event);
    if (id !== "" && !(await profiles()).some(profile => profile.id === id))
      throw new Error("此 Shell 当前不可用");
    assertWorkspace(event);
    settings.setLocalShellProfile(id);
  });

  ipcMain.handle("local-terminal:start", async (event, input) => {
    assertWorkspace(event);
    const { id, profile: requested, cols, rows } = input ?? {};
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
        !validSize(cols) || !validSize(rows))
      throw new Error("无效的本地终端请求");
    const profile = (await profiles()).find(({ id }) => id === requested);
    assertWorkspace(event);
    if (!profile) throw new Error("此 Shell 当前不可用，请重新选择");
    if (sessions.has(id)) throw new Error("本地终端已存在");

    const { sender } = event;
    let terminal;
    try {
      // The Windows ConPTY reader starts a worker from node-pty's on-disk directory.
      const binding = process.platform === "win32"
        ? require.resolve("node-pty").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2")
        : "node-pty";
      terminal = require(binding).spawn(profile.file, profile.args, {
        name: "xterm-256color", cols, rows, cwd: os.homedir(),
        ...(process.platform === "win32" && { useConptyDll: true }),
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...profile.env },
      });
    } catch (error) {
      throw new Error(`无法启动 ${profile.name}：${error.message}`);
    }
    const session = { owner: sender.id, terminal, pending: 0, paused: false };
    sessions.set(id, session);
    const emit = (event) => {
      if (!sender.isDestroyed()) sender.send("local-terminal:event", { ...event, id });
    };
    session.data = terminal.onData(data => {
      session.pending += data.length;
      if (!session.paused && session.pending >= highWater) {
        terminal.pause();
        session.paused = true;
      }
      emit({ type: "data", data });
    });
    session.exit = terminal.onExit(({ exitCode, signal }) => {
      session.terminal = null;
      session.data.dispose();
      session.exit.dispose();
      emit({ type: "exit", exitCode, signal });
    });
  });

  ipcMain.on("local-terminal:send", (event, message) => {
    const { id, type, data, cols, rows, length } = message ?? {};
    const session = sessions.get(id);
    if (!session || session.owner !== event.sender.id || !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame) return;
    if (type === "disconnect") {
      close(id, session);
      return;
    }
    const { terminal } = session;
    if (!terminal) return;
    try {
      if (type === "input" && typeof data === "string") terminal.write(data);
      else if (type === "resize" && validSize(cols) && validSize(rows) &&
          (terminal.cols !== cols || terminal.rows !== rows)) terminal.resize(cols, rows);
      else if (type === "ack" && Number.isInteger(length) && length > 0 && length <= session.pending) {
        session.pending -= length;
        if (session.paused && session.pending <= lowWater) {
          session.paused = false;
          terminal.resume();
        }
      }
    } catch {
      // A process can exit between the last data event and a write or resize.
    }
  });

  return {
    owns: (sender, id) => sessions.get(id)?.owner === sender.id,
    count: (owner) => [...sessions.values()].filter(session => session.owner === owner && session.terminal).length,
    closeWindow(owner) {
      for (const [id, session] of sessions) if (session.owner === owner) close(id, session);
    },
  };
}

module.exports = { installLocalTerminals };
