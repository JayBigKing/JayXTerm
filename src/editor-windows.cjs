const { BrowserWindow, dialog, ipcMain, screen } = require("electron");
const path = require("node:path");
const { maxFileBytes } = require("./remote-text.cjs");

function installEditorWindows({ ensureOwner, request, connected, didSave }) {
  const files = new Map();
  const windows = new Map();
  const encoding = (value) => {
    if (value !== "utf-8" && value !== "gbk") throw new Error("不支持的文件编码");
    return value;
  };

  async function openWindow(file, parent) {
    const data = await request({ id: file.id, path: file.path, action: "read-text" });
    if (!connected(file.id) || !parent || parent.isDestroyed())
      throw new Error("SSH 会话已断开");
    const area = screen.getDisplayMatching(parent.getBounds()).workArea;
    const width = Math.min(980, area.width);
    const height = Math.min(730, area.height);
    const offset = (windows.size % 7) * 26;
    const win = new BrowserWindow({
      icon: path.join(__dirname, "../assets/jayxterm.png"),
      width, height, minWidth: Math.min(480, width), minHeight: Math.min(340, height),
      x: area.x + Math.min(area.width - width, 54 + offset),
      y: area.y + Math.min(area.height - height, 52 + offset),
      show: false,
      backgroundColor: "#15191f",
      title: `${file.name} · ${file.server} · JayXTerm`,
      webPreferences: {
        preload: path.join(__dirname, "editor-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const id = win.webContents.id;
    Object.assign(file, {
      data, remote: data.path, version: data.version,
      encoding: data.encoding, eol: data.eol, bom: data.bom,
    });
    windows.set(id, file);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("page-title-updated", (event) => event.preventDefault());
    win.on("closed", () => {
      windows.delete(id);
      files.delete(file.key);
    });
    win.on("close", (event) => {
      if (file.allowClose || (!file.dirty && !file.busy)) return;
      event.preventDefault();
      if (file.busy || file.confirming) return;
      file.confirming = true;
      dialog.showMessageBox(win, {
        type: "warning",
        message: `丢弃对 ${file.name} 的未保存修改？`,
        buttons: ["取消", "丢弃并关闭"],
        defaultId: 0,
        cancelId: 0,
      }).then(({ response }) => {
        if (response === 1 && !win.isDestroyed()) {
          file.allowClose = true;
          win.close();
        }
      }).finally(() => {
        file.confirming = false;
      }).catch(() => {});
    });
    try {
      await win.loadFile(path.join(__dirname, "../.codex-cache/build/renderer/editor.html"));
      if (!win.isDestroyed()) win.show();
      return win;
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  ipcMain.handle("editor:open", async (event, { id, path: remote }) => {
    const session = ensureOwner(event.sender, id);
    if (
      typeof remote !== "string" || !path.posix.isAbsolute(remote) ||
      remote.includes("\0") || remote !== path.posix.normalize(remote) || remote.endsWith("/")
    )
      throw new Error("无效的远程文件路径");
    const key = JSON.stringify([id, remote]);
    const existing = files.get(key);
    if (existing) {
      const win = await existing;
      if (!win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return;
    }
    const file = { id, path: remote, key, name: path.posix.basename(remote), server: session.name };
    const opening = openWindow(file, BrowserWindow.fromWebContents(event.sender));
    files.set(key, opening);
    try {
      await opening;
    } catch (error) {
      files.delete(key);
      throw error;
    }
  });

  function editor(event) {
    const file = windows.get(event.sender.id);
    if (!file) throw new Error("远程文件窗口不存在");
    return file;
  }

  ipcMain.handle("editor:initialize", (event) => {
    const file = editor(event);
    const data = file.data;
    file.data = null;
    return { ...data, server: file.server, name: file.name, path: file.path };
  });
  ipcMain.on("editor:dirty", (event, dirty) => {
    const file = windows.get(event.sender.id);
    if (file) file.dirty = dirty === true;
  });

  async function operate(event, callback) {
    const file = editor(event);
    if (!connected(file.id))
      throw new Error("原 SSH 会话不可用。请复制当前修改，再从已连接的会话打开文件");
    if (file.busy) throw new Error("请等待当前文件操作完成");
    file.busy = true;
    try {
      return await callback(file);
    } finally {
      file.busy = false;
    }
  }

  ipcMain.handle("editor:reload", (event, choice) => operate(event, async (file) => {
    const data = await request({
      id: file.id, path: file.remote, action: "read-text", encoding: encoding(choice),
    });
    if (data.path !== file.remote) throw new Error("远程目录已更改，请重新打开文件");
    Object.assign(file, { version: data.version, encoding: data.encoding, eol: data.eol, bom: data.bom });
    return data;
  }));
  ipcMain.handle("editor:save", (event, { text, encoding: choice, force }) => operate(event, async (file) => {
    if (typeof text !== "string" || text.length > maxFileBytes)
      throw new Error("保存后的文件不能超过 2 MiB");
    const targetEncoding = encoding(choice);
    let forceFormat;
    if (force === true) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
        type: "warning",
        message: `强制保存 ${file.name}？`,
        detail: `${file.server} · ${file.remote}\n远端文件会被当前编辑内容覆盖，包括打开后在服务器上发生的修改。`,
        buttons: ["取消", "强制覆盖"],
        defaultId: 0,
        cancelId: 0,
      });
      if (response !== 1) return { cancelled: true };
      if (!connected(file.id)) throw new Error("原 SSH 会话不可用。请复制当前修改，再从已连接的会话打开文件");
      forceFormat = { eol: file.eol, bom: file.bom };
    }
    const result = await request({
      id: file.id, path: file.remote, action: "save-text", version: file.version,
      sourceEncoding: file.encoding, encoding: targetEncoding, text, forceFormat,
    });
    file.version = result.version;
    file.encoding = targetEncoding;
    file.bom = file.bom && targetEncoding === "utf-8";
    didSave(file.id, path.posix.dirname(file.path));
    return result;
  }));
}
module.exports = { installEditorWindows };
