const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { safeName } = require("./transfers.cjs");

const encode = (value) => Buffer.from(value, "utf8").toString("base64");
const discard = (folder) =>
  folder && fs.rm(folder, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});

async function prune(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("drag-")) continue;
    const folder = path.join(root, entry.name);
    if (Date.now() - (await fs.stat(folder)).mtimeMs > 24 * 60 * 60 * 1000)
      await discard(folder);
  }
}

function installLocalDrag({ ipcMain, helper, tempRoot, ensureOwner, ready, request, busyTransfers, remoteDrags }) {
  let child;
  let operation;
  const notify = (job, message) => {
    if (!job.sender.isDestroyed())
      job.sender.send("window:event", {
        type: "local-drag-status", id: job.id, message, active: operation?.id === job.id,
      });
  };
  function finish(job, status) {
    if (operation !== job) return;
    operation = null;
    busyTransfers.delete(job.id);
    if (job.error) status = "failed";
    if (job.relay && status !== "copy") remoteDrags.delete(job.token);
    // A renderer drop can arrive before the helper's done message. Release the
    // source transfer lock before allowing the internal relay to start.
    job.resolveDrop?.(status);
    notify(job, job.relay?.claimed ? undefined : job.error || (status === "copy" ? "本地拖放完成" :
      status === "cancelled" ? "已取消本地拖放" :
      status === "rejected" ? "目标没有接受拖放，请放到 Windows 桌面、文件夹或 SSH 文件列表内" :
      status === "released" ? "本地拖放未启动，拖动时请保持按住左键" :
      "本地拖放失败，请查看远端文件状态或使用下载按钮"));
    if (!job.answering) discard(job.folder);
  }

  async function replyTo(line, process) {
    const [action, token, index] = line.split("\t");
    const job = operation;
    if (!job || job.token !== token || child !== process) return;
    if (action === "done") {
      finish(job, index);
      return;
    }
    job.answering = true;
    try {
      ensureOwner(job.sender, job.id);
      if (!ready(job.id)) throw new Error("SSH 连接已断开");
      if (action === "manifest") {
        job.entries ??= await request({ id: job.id, action: "drag-manifest", path: job.remote });
        if (operation !== job) return;
        process.stdin.write("entries\t" + job.entries.length + "\n" +
          job.entries.map((entry) => [encode(entry.name), Number(entry.directory), entry.size].join("\t")).join("\n") + "\n");
        return;
      }
      const entry = job.entries?.[index];
      if (action !== "file" || !/^\d+$/.test(index) || !entry || entry.directory)
        throw new Error("本地拖放请求无效");
      let file = job.staged.get(index);
      if (!file) {
        if (!job.folder) {
          await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
          if (!(await fs.lstat(tempRoot)).isDirectory()) throw new Error("本地拖放缓存目录无效");
          job.folder = await fs.mkdtemp(path.join(tempRoot, "drag-"));
        }
        notify(job, "正在从远端读取 " + path.posix.basename(entry.remote));
        file = path.join(job.folder, index);
        const result = await request({
          id: job.id, action: "download", local: file, path: entry.remote, expectedFileSize: entry.size,
        });
        if (result.files !== 1 || (await fs.stat(file)).size !== entry.size)
          throw new Error("远程文件大小已变化，请重新拖动");
        job.staged.set(index, file);
      }
      if (operation === job) process.stdin.write("path\t" + encode(file) + "\n");
    } catch (error) {
      if (operation === job) {
        job.error = error.message;
        process.stdin.write("error\n");
      }
    } finally {
      job.answering = false;
      if (operation !== job) discard(job.folder);
    }
  }

  function warm() {
    if (!helper || child) return;
    const process = spawn(helper.file, helper.args || [], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: helper.env,
    });
    child = process;
    const reader = readline.createInterface({ input: process.stdout, crlfDelay: Infinity });
    reader.on("line", (line) => replyTo(line, process));
    process.stdin.on("error", () => {});
    function stopped() {
      if (child !== process) return;
      child = null;
      if (operation) finish(operation, "failed");
    }
    process.on("error", stopped);
    process.on("close", stopped);
  }

  ipcMain.handle("local-drag:available", () => Boolean(helper));
  ipcMain.on("local-drag:warm", warm);
  ipcMain.on("local-drag:start", (event, { id, path: remote, token } = {}) => {
    if (!helper) return;
    const job = { id, remote, sender: event.sender };
    try {
      ensureOwner(job.sender, id);
      if (!ready(id)) throw new Error("请先连接 SSH");
      if (operation || busyTransfers.has(id)) throw new Error("请等待当前传输完成");
      if (typeof remote !== "string" || !path.posix.isAbsolute(remote) ||
        remote.includes("\0") || remote.endsWith("/") || path.posix.normalize(remote) !== remote)
        throw new Error("无效的远程文件路径");
      // SSH-to-SSH copies allow POSIX names such as "report:latest". Validate
      // Windows names only when the Shell actually requests the manifest.
      if (token === undefined) safeName(path.posix.basename(remote));
      if (token !== undefined) {
        const relay = remoteDrags?.get(token);
        if (!relay || relay.id !== id || relay.remote !== remote ||
            relay.owner !== job.sender.id || relay.expires <= Date.now() || relay.nativeDrop)
          throw new Error("拖放已失效，请重新拖动文件");
        job.relay = relay;
        relay.nativeDrop = new Promise((resolve) => { job.resolveDrop = resolve; });
      }
      job.token = token ?? randomUUID();
      warm();
      job.staged = new Map();
      operation = job;
      busyTransfers.add(id);
      notify(job, job.relay ? "拖到 Windows 桌面、文件夹或其他 SSH 面板后松开" : "拖到 Windows 桌面或文件夹后松开");
      child.stdin.write("drag\t" + job.token +
        (job.relay ? "\t" + encode("jayxterm-sftp:" + job.token) : "") + "\n");
    } catch (error) {
      if (operation === job) finish(job, "failed");
      else if (job.relay) {
        remoteDrags.delete(job.token);
        job.resolveDrop("failed");
      }
      notify(job, error.message);
    }
  });

  if (helper) prune(tempRoot).catch(() => {});
  return () => child?.kill();
}

module.exports = { installLocalDrag };
