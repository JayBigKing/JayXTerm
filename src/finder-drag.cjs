const fs = require("node:fs/promises");
const path = require("node:path");

function relayData(token) {
  const fields = ["application/x-jayxterm-sftp", token].map((value) => Buffer.from(value, "utf16le"));
  // Chromium's macOS drag pasteboard uses a Pickle with aligned UTF-16 strings.
  const payload = 4 + fields.reduce((size, field) => size + 4 + Math.ceil(field.length / 4) * 4, 0);
  const data = Buffer.alloc(4 + payload);
  data.writeUInt32LE(payload);
  data.writeUInt32LE(1, 4);
  let offset = 8;
  for (const field of fields) {
    data.writeUInt32LE(field.length / 2, offset);
    field.copy(data, offset + 4);
    offset += 4 + Math.ceil(field.length / 4) * 4;
  }
  return data;
}

function installFinderDrag({
  ipcMain, native, loadError, windowFor, logFile, ensureOwner, ready, request, busyTransfers,
  createRemoteDrag, remoteDrags,
}) {
  let logWrite = Promise.resolve();
  function record(attempt, phase, error) {
    const entry = { time: attempt, phase };
    if (error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)) entry.code = error.code;
    logWrite = logWrite.then(async () => {
      await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(logFile, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
    }).catch(error => console.error("Finder drag log write failed:", error.code));
  }
  const notify = (sender, id, message, active = false) => {
    if (!sender.isDestroyed()) sender.send("window:event", { type: "local-drag-status", id, message, active });
  };
  function assertReady(sender, id) {
    ensureOwner(sender, id);
    if (!ready(id)) throw new Error("SSH 连接已断开");
    if (busyTransfers.has(id)) throw new Error("请等待当前传输完成");
  }

  record(new Date().toISOString(), native ? "ready" : "module-unavailable", loadError);
  ipcMain.handle("local-drag:available", () => native ? "finder" : false);
  ipcMain.on("finder-drag:arm", ({ sender }, { id, path: remote, directory } = {}) => {
    if (!native) return;
    const attempt = new Date().toISOString();
    let token;
    try {
      assertReady(sender, id);
      if (typeof remote !== "string" || !path.posix.isAbsolute(remote) ||
          remote.includes("\0") || remote === "/" || remote.endsWith("/") || path.posix.normalize(remote) !== remote)
        throw new Error("无效的远程文件路径");
      const name = path.posix.basename(remote);
      const window = windowFor(sender);
      if (!window || window.isDestroyed()) throw new Error("工作台窗口已关闭");
      token = createRemoteDrag(sender, id, remote);
      if (!token) throw new Error("拖放已失效，请重新拖动文件");
      const drag = remoteDrags.get(token);
      const armed = native.arm(window.getNativeWindowHandle(), name, directory === true, relayData(token), async (target, complete) => {
        record(attempt, "finder-requested-file");
        let staging;
        let ownsTransfer = false;
        try {
          assertReady(sender, id);
          if (drag.claimed) throw new Error("此拖放请求已处理");
          drag.claimed = true;
          remoteDrags.delete(token);
          if (!path.isAbsolute(target)) throw new Error("Finder 未提供有效的目标");
          busyTransfers.add(id);
          ownsTransfer = true;
          notify(sender, id, "正在下载到 Finder…", true);
          staging = await fs.mkdtemp(path.join(path.dirname(target), ".jayxterm-drop-"));
          const local = path.join(staging, "download");
          await request({ id, action: "download", path: remote, local });
          native.publish(local, target);
          record(attempt, "complete");
          complete();
          notify(sender, id, "Finder 下载完成");
        } catch (error) {
          record(attempt, "download-failed", error);
          const message = error.code === "EEXIST" ? "Finder 目标已存在，请选择其他目录" : error.message;
          complete(message);
          notify(sender, id, "Finder 下载失败：" + message);
        } finally {
          if (ownsTransfer) busyTransfers.delete(id);
          if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        }
      });
      if (!armed) remoteDrags.delete(token);
    } catch (error) {
      if (token) remoteDrags.delete(token);
      record(attempt, "start-failed", error);
      notify(sender, id, error.message);
    }
  });
}

module.exports = { installFinderDrag };
