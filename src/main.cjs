const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  Menu,
  clipboard,
} = require("electron");
const { createWindows } = require("./windows.cjs");
const { normalizeEncoding } = require("./codec.cjs");
const path = require("node:path");
const fs = require("node:fs/promises");
const { safeName } = require("./transfers.cjs");
const { installEditorWindows } = require("./editor-windows.cjs");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { openStore, validateSession } = require("./store.cjs");
// Deliberately use software rendering as the initial performance baseline.
app.setName("JayXTerm");
app.disableHardwareAcceleration();
if (!app.isPackaged) {
  app.setPath(
    "userData",
    path.join(
      __dirname,
      process.env.JAYXTERM_QA
        ? "../.codex-cache/qa/profile"
        : "../.codex-cache/profile",
    ),
  );
  app.setPath(
    "sessionData",
    path.join(
      __dirname,
      process.env.JAYXTERM_QA
        ? "../.codex-cache/qa/chromium"
        : "../.codex-cache/chromium",
    ),
  );
}
let window, worker, store, workspace;
const owners = new Map(),
  states = new Map(),
  busyTransfers = new Set();
function parentFor(id) {
  return workspace.owner(id) || BrowserWindow.getFocusedWindow() || window;
}
function ensureOwner(sender, id) {
  workspace.assertOwner(sender, id);
  if (workspace.moves.has(id)) throw new Error("会话正在移动");
}
const hasInstanceLock =
  process.env.JAYXTERM_QA || app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
const active = new Map(),
  requests = new Map();
const tests = new Map();
const remoteDrags = new Map();
function storedPassword(id) {
  const s = store.get().sessions.find((s) => s.id === id);
  return s?.password
    ? safeStorage.decryptString(Buffer.from(s.password, "base64"))
    : "";
}
function finishTest(id, error, result) {
  const t = tests.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  tests.delete(id);
  active.delete(id);
  owners.delete(id);
  states.delete(id);
  send({ type: "disconnect", id });
  error ? t.reject(new Error(error)) : t.resolve(result);
}
function send(m) {
  if (worker?.connected) worker.send(m);
}
function safeSessions() {
  return store
    .get()
    .sessions.map(({ password, ...s }) => ({ ...s, hasPassword: !!password }));
}
function request(message) {
  return new Promise((resolve, reject) => {
    const rid = randomUUID();
    const timer = ["upload", "download", "relay", "save-text"].includes(message.action)
      ? null
      : setTimeout(() => {
          requests.delete(rid);
          reject(new Error("文件操作超时"));
        }, 30000);
    requests.set(rid, { resolve, reject, timer });
    send({ ...message, type: message.type || "sftp", rid });
  });
}
app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  store = openStore(path.join(app.getPath("userData"), "sessions.json"));
  worker = fork(path.join(__dirname, "ssh-worker.cjs"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  workspace = createWindows({
    active,
    owners,
    states,
    send,
    request,
    isBusy: (id) => busyTransfers.has(id),
    onDisconnect: (id) => {
      active.delete(id);
      states.delete(id);
      if (tests.has(id)) finishTest(id, "窗口已关闭");
    },
  });
  Menu.setApplicationMenu(null);
  window = workspace.create();
  worker.on("message", async (m) => {
    if (
      tests.has(m.id) &&
      ["test-result", "error", "closed"].includes(m.type)
    ) {
      finishTest(
        m.id,
        m.type === "test-result" ? null : m.message || "测试连接已关闭",
        m.result,
      );
      return;
    }
    if (m.type === "result") {
      const r = requests.get(m.rid);
      if (r) {
        clearTimeout(r.timer);
        requests.delete(m.rid);
        m.error ? r.reject(new Error(m.error)) : r.resolve(m.result);
      }
      return;
    }
    if (m.type === "hostkey") {
      const config = active.get(m.id);
      if (!config) return send({ type: "verify", id: m.id, accept: false });
      const host = JSON.stringify([config.host, config.port]);
      const known = store.get().hosts[host];
      let accept = known === m.fingerprint;
      if (!accept) {
        const { response } = await dialog.showMessageBox(parentFor(m.id), {
          type: known ? "warning" : "question",
          buttons: ["取消连接", "信任并连接"],
          defaultId: 0,
          cancelId: 0,
          title: known ? "服务器指纹发生变化" : "首次连接此服务器",
          message: `${config.host}:${config.port}`,
          detail: `请通过可信渠道核对服务器指纹。\n\n${m.fingerprint}${known ? "\n\n原指纹：" + known : ""}`,
        });
        accept = response === 1;
        if (accept) {
          const d = store.get();
          store.write({ ...d, hosts: { ...d.hosts, [host]: m.fingerprint } });
        }
      }
      send({ type: "verify", id: m.id, accept });
      return;
    }
    if (
      owners.has(m.id) &&
      (m.type === "ready" || m.type === "closed" || m.type === "error")
    )
      states.set(m.id, m.type);
    const owner = workspace.owner(m.id);
    if (m.type === "closed") active.delete(m.id);
    if (owner && !owner.isDestroyed()) owner.webContents.send("ssh:event", m);
  });
  worker.on("exit", () => {
    for (const id of active.keys())
      workspace.owner(id)?.webContents.send("ssh:event", {
        type: "error",
        id,
        message: "SSH 后台进程已退出，请重启应用",
      });
    active.clear();
    for (const id of tests.keys()) finishTest(id, "SSH 后台进程已退出");
    for (const r of requests.values()) {
      clearTimeout(r.timer);
      r.reject(new Error("SSH 后台进程已退出"));
    }
    requests.clear();
  });
});
// Clipboard access is demand-driven; terminal output never touches it.
ipcMain.handle("clipboard:read", () => clipboard.readText());
ipcMain.handle("clipboard:write", (_e, text) => {
  if (typeof text !== "string") throw new Error("无效的剪贴板文本");
  clipboard.writeText(text);
});
ipcMain.handle("clipboard:menu", (e, { id, hasSelection, canPaste }) => {
  workspace.assertOwner(e.sender, id);
  const win = workspace.get(e.sender.id);
  const act = (action) => {
    if (win && !win.isDestroyed())
      win.webContents.send("window:event", { type: "clipboard", id, action });
  };
  Menu.buildFromTemplate([
    {
      label: "复制",
      enabled: !!hasSelection,
      click: () => act("copy"),
    },
    {
      label: "粘贴",
      enabled: !!canPaste,
      click: () => act("paste"),
    },
    { type: "separator" },
    { label: "全选终端文本", click: () => act("select-all") },
  ]).popup({ window: win });
});
ipcMain.handle("sessions:list", () => safeSessions());
ipcMain.handle("sessions:reveal", (_e, id) => storedPassword(id));
ipcMain.handle("ssh:test", (e, input) => {
  const config = validateSession({
    ...input,
    name: String(input.name || "").trim() || "测试连接",
  });
  const password = input.password || storedPassword(input.id);
  const id = randomUUID();
  active.set(id, config);
  owners.set(id, e.sender.id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finishTest(id, "测试连接超时"), 120000);
    tests.set(id, { resolve, reject, timer });
    send({ type: "connect", id, config, password, test: true });
  });
});
ipcMain.handle("ssh:encoding", async (e, { id, encoding }) => {
  ensureOwner(e.sender, id);
  const s = active.get(id);
  if (!s) throw new Error("会话已断开");
  encoding = normalizeEncoding(encoding);
  const result = await request({ type: "encoding", id, encoding });
  const d = store.get();
  store.write({
    ...d,
    sessions: d.sessions.map((item) =>
      item.id === s.id ? { ...item, encoding } : item,
    ),
  });
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return result;
});
ipcMain.handle("sessions:save", (e, input) => {
  const s = validateSession(input),
    d = store.get(),
    old = d.sessions.find((x) => x.id === s.id);
  if (input.remember) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("系统安全存储不可用，无法保存密码");
    s.password = input.password
      ? safeStorage.encryptString(input.password).toString("base64")
      : old?.password;
  }
  store.write({
    ...d,
    sessions: [...d.sessions.filter((x) => x.id !== s.id), s],
  });
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return safeSessions();
});
ipcMain.handle("sessions:delete", (e, id) => {
  const d = store.get();
  store.write({ ...d, sessions: d.sessions.filter((s) => s.id !== id) });
  workspace.broadcast({ type: "sessions-changed" }, e.sender.id);
  return safeSessions();
});
ipcMain.handle("ssh:connect", (e, { sessionId, password, cols, rows }) => {
  const s = store.get().sessions.find((s) => s.id === sessionId);
  if (!s) throw new Error("会话不存在");
  const id = randomUUID();
  const secret =
    password ||
    (s.password
      ? safeStorage.decryptString(Buffer.from(s.password, "base64"))
      : "");
  active.set(id, s);
  owners.set(id, e.sender.id);
  states.set(id, "connecting");
  send({
    type: "connect",
    id,
    config: {
      host: s.host,
      port: s.port,
      username: s.username,
      encoding: s.encoding || "utf-8",
    },
    password: secret,
    cols,
    rows,
  });
  return id;
});
ipcMain.on("ssh:send", (e, m) => {
  if (
    m.type === "disconnect" &&
    owners.get(m.id) === e.sender.id &&
    !workspace.moves.has(m.id)
  ) {
    send(m);
    owners.delete(m.id);
    active.delete(m.id);
    states.delete(m.id);
    return;
  }
  if (
    active.has(m.id) &&
    owners.get(m.id) === e.sender.id &&
    (!workspace.moves.has(m.id) || ["ack", "resize"].includes(m.type)) &&
    ["input", "resize", "ack", "disconnect"].includes(m.type)
  )
    send(m);
});
ipcMain.handle("sftp:list", (e, { id, path: remote }) => {
  ensureOwner(e.sender, id);
  return request({ id, action: "list", path: remote });
});
function editorConnectionReady(id) {
  return active.has(id) && states.get(id) === "ready" && !workspace.moves.has(id);
}
installEditorWindows({
  request,
  connected: editorConnectionReady,
  ensureOwner(sender, id) {
    ensureOwner(sender, id);
    if (!editorConnectionReady(id)) throw new Error("请先连接 SSH");
    return active.get(id);
  },
  didSave(id, directory) {
    const win = workspace.owner(id);
    if (win && !win.isDestroyed())
      win.webContents.send("window:event", { type: "remote-text-saved", id, directory });
  },
});
async function confirmReplace(id, target, directory = false) {
  const answer = await dialog.showMessageBox(parentFor(id), {
    type: "warning",
    buttons: ["取消", directory ? "合并并覆盖同名文件" : "覆盖文件"],
    defaultId: 0,
    cancelId: 0,
    message: directory
      ? "目标目录已存在，是否合并？"
      : "目标文件已存在，是否覆盖？",
    detail:
      target +
      (directory ? "\n保留目标中其他文件，覆盖本次传输中遇到的同名文件。" : ""),
  });
  return answer.response === 1;
}
async function uploadPaths(id, remote, paths) {
  let files = 0,
    bytes = 0,
    skipped = 0;
  for (const local of paths) {
    const name = path.basename(local);
    if (!name || name === "." || name === "..")
      throw new Error("不能上传文件系统根目录");
    const destination = path.posix.join(remote, name);
    const stat = await request({ id, action: "stat", path: destination });
    if (
      stat.exists &&
      !(await confirmReplace(id, destination, stat.directory))
    ) {
      skipped++;
      continue;
    }
    const result = await request({
      id,
      action: "upload",
      local,
      path: destination,
    });
    files += result.files;
    bytes += result.bytes;
  }
  return { files, bytes, skipped };
}
// Only the window owning the source connection can create a drag token.
ipcMain.on("sftp:drag-token", (e, { id, path: remote }) => {
  if (
    owners.get(id) !== e.sender.id ||
    states.get(id) !== "ready" ||
    workspace.moves.has(id) ||
    typeof remote !== "string" ||
    !remote.startsWith("/") ||
    remote.includes("\0") ||
    remote === "/"
  ) {
    e.returnValue = "";
    return;
  }
  const now = Date.now();
  for (const [token, drag] of remoteDrags)
    if (drag.expires <= now) remoteDrags.delete(token);
  if (remoteDrags.size >= 128)
    remoteDrags.delete(remoteDrags.keys().next().value);
  const token = randomUUID();
  remoteDrags.set(token, {
    id,
    remote,
    owner: e.sender.id,
    expires: now + 120000,
  });
  e.returnValue = token;
});
ipcMain.handle("sftp:relay", async (e, { id, path: directory, token }) => {
  ensureOwner(e.sender, id);
  const drag = remoteDrags.get(token);
  if (!drag || drag.expires <= Date.now() || owners.get(drag.id) !== drag.owner)
    throw new Error("拖放已失效，请重新拖动文件");
  remoteDrags.delete(token);
  const source = active.get(drag.id),
    target = active.get(id);
  if (
    !source ||
    !target ||
    states.get(drag.id) !== "ready" ||
    states.get(id) !== "ready" ||
    workspace.moves.has(drag.id)
  )
    throw new Error("源或目标 SSH 连接已断开或正在移动");
  if (
    typeof directory !== "string" ||
    !directory.startsWith("/") ||
    directory.includes("\0")
  )
    throw new Error("请选择有效的目标目录");
  if (busyTransfers.has(id) || busyTransfers.has(drag.id))
    throw new Error("请等待当前传输完成");
  const endpoint = (session) => JSON.stringify([session.host, session.port]);
  const hosts = store.get().hosts;
  const sameServer =
    endpoint(source) === endpoint(target) ||
    Boolean(
      hosts[endpoint(source)] &&
      hosts[endpoint(source)] === hosts[endpoint(target)],
    );
  busyTransfers.add(id);
  busyTransfers.add(drag.id);
  try {
    return await request({
      id,
      action: "relay",
      source: drag.id,
      from: drag.remote,
      path: directory,
      sameServer,
    });
  } finally {
    busyTransfers.delete(id);
    busyTransfers.delete(drag.id);
  }
});
ipcMain.handle("sftp:drop", async (e, { id, path: remote, paths }) => {
  ensureOwner(e.sender, id);
  if (!active.has(id)) throw new Error("会话已断开");
  if (
    !Array.isArray(paths) ||
    paths.some((p) => typeof p !== "string" || !path.isAbsolute(p))
  )
    throw new Error("无效的本地文件");
  if (busyTransfers.has(id)) throw new Error("请等待当前传输完成");
  busyTransfers.add(id);
  try {
    return await uploadPaths(id, remote, paths);
  } finally {
    busyTransfers.delete(id);
  }
});
ipcMain.handle(
  "sftp:transfer",
  async (e, { id, action, path: remote, directory }) => {
    ensureOwner(e.sender, id);
    if (!active.has(id)) throw new Error("会话已断开");
    if (busyTransfers.has(id)) throw new Error("请等待当前传输完成");
    busyTransfers.add(id);
    try {
      if (action === "upload" || action === "upload-directory") {
        const r = await dialog.showOpenDialog(parentFor(id), {
          properties:
            action === "upload-directory"
              ? ["openDirectory", "multiSelections"]
              : ["openFile", "multiSelections"],
        });
        if (r.canceled) return { cancelled: true };
        return await uploadPaths(id, remote, r.filePaths);
      }
      if (action === "download") {
        let local;
        if (directory) {
          const r = await dialog.showOpenDialog(parentFor(id), {
            title: "选择下载到的本地目录",
            properties: ["openDirectory", "createDirectory"],
          });
          if (r.canceled) return { cancelled: true };
          local = path.join(
            r.filePaths[0],
            safeName(path.posix.basename(remote)),
          );
          let exists = false;
          try {
            await fs.lstat(local);
            exists = true;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (exists && !(await confirmReplace(id, local, true)))
            return { cancelled: true };
        } else {
          const r = await dialog.showSaveDialog(parentFor(id), {
            defaultPath: safeName(path.posix.basename(remote)),
          });
          if (r.canceled) return { cancelled: true };
          local = r.filePath;
        }
        return await request({ id, action, local, path: remote });
      }
      throw new Error("未知文件操作");
    } finally {
      busyTransfers.delete(id);
    }
  },
);
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => worker?.kill());
app.on("second-instance", () => {
  if (workspace) workspace.create();
});
