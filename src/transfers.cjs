const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const call = (s, method, ...args) =>
  new Promise((resolve, reject) =>
    s[method](...args, (err, value) => (err ? reject(err) : resolve(value))),
  );
function safeName(name) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[ .]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)
  )
    throw new Error("无法安全保存此文件名：" + name);
  return name;
}
function validateRemoteRemoval(remote) {
  if (typeof remote !== "string" || !remote.startsWith("/") || remote === "/" ||
      remote.includes("\0") || remote.endsWith("/") || path.posix.normalize(remote) !== remote)
    throw new Error("无效的远程删除路径，不能删除根目录");
}
async function removalEntry(sftp, remote) {
  const parent = path.posix.dirname(remote);
  if (await call(sftp, "realpath", parent) !== parent)
    throw new Error("远程父目录已变化，请刷新后重新删除：" + parent);
  const stat = await call(sftp, "lstat", remote);
  const link = stat.isSymbolicLink();
  const directory = stat.isDirectory() && !link;
  if (directory && await call(sftp, "realpath", remote) !== remote)
    throw new Error("远程目录包含符号链接，请从真实路径删除：" + remote);
  // atime can change during preview, so it is excluded from the comparison.
  const attributes = [stat.mode, stat.uid, stat.gid, stat.size, stat.mtime];
  return { remote, directory, fingerprint: JSON.stringify([link, directory, attributes]) };
}
async function removalPlan(sftp, remote) {
  validateRemoteRemoval(remote);
  const hash = createHash("sha256");
  let count = 0;
  async function visit(target, depth) {
    if (depth > 100 || ++count > 10000)
      throw new Error("待删除目录过大或层级过深，请分批删除");
    const entry = await removalEntry(sftp, target);
    hash.update(JSON.stringify([entry.remote, entry.fingerprint]) + "\n");
    entry.children = [];
    if (!entry.directory) return entry;
    const names = (await call(sftp, "readdir", target))
      .map((item) => item.filename).filter((name) => name !== "." && name !== "..").sort();
    for (const name of names) {
      if (!name || /[\/\0]/.test(name)) throw new Error("无效的远程文件名");
      entry.children.push(await visit(path.posix.join(target, name), depth + 1));
    }
    return entry;
  }
  const root = await visit(remote, 0);
  return { root, revision: hash.digest("hex"), count };
}
async function previewRemoteRemoval(sftp, remote) {
  const { root, revision, count } = await removalPlan(sftp, remote);
  return { directory: root.directory, revision, count };
}
async function removeRemote(sftp, remote, revision) {
  const plan = await removalPlan(sftp, remote);
  if (plan.revision !== revision)
    throw new Error("远端删除目标或目录内容已变化，请刷新后重新确认");
  let files = 0, directories = 0;
  async function remove(entry) {
    const current = await removalEntry(sftp, entry.remote);
    if (current.fingerprint !== entry.fingerprint)
      throw new Error("远端删除目标已变化，删除已停止：" + entry.remote);
    if (entry.directory) {
      for (const child of entry.children) await remove(child);
      await call(sftp, "rmdir", entry.remote);
      directories++;
    } else {
      await call(sftp, "unlink", entry.remote);
      files++;
    }
  }
  await remove(plan.root);
  return { files, directories };
}
async function noLocalLink(local) {
  try {
    const stat = await fs.lstat(local);
    if (stat.isSymbolicLink()) throw new Error("不覆盖本地符号链接：" + local);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
async function remoteMissing(s, remote) {
  try {
    return await call(s, "lstat", remote);
  } catch (e) {
    if (e.code === 2) return null;
    throw e;
  }
}
async function transferTree(s, action, local, remote, progress = () => {}, expectedFileSize) {
  let completed = 0,
    files = 0;
  let last = 0;
  function report(name, current = 0, total = 0) {
    const now = Date.now();
    if (now - last > 120 || current === total) {
      last = now;
      progress({ name, current, total, completed, files });
    }
  }
  async function upload(local, remote, depth = 0) {
    if (depth > 100) throw new Error("目录层级过深");
    const stat = await fs.lstat(local);
    if (stat.isSymbolicLink()) throw new Error("暂不传输符号链接：" + local);
    const existing = await remoteMissing(s, remote);
    if (existing?.isSymbolicLink())
      throw new Error("不覆盖远程符号链接：" + remote);
    if (stat.isDirectory()) {
      if (existing && !existing.isDirectory())
        throw new Error("目标已存在且不是目录：" + remote);
      if (!existing) await call(s, "mkdir", remote);
      for (const name of await fs.readdir(local))
        await upload(
          path.join(local, name),
          path.posix.join(remote, name),
          depth + 1,
        );
    } else if (stat.isFile()) {
      if (existing?.isDirectory())
        throw new Error("目标已存在且是目录：" + remote);
      await call(s, "fastPut", local, remote, {
        step: (current, _chunk, total) => report(remote, current, total),
      });
      completed += stat.size;
      files++;
      report(remote, stat.size, stat.size);
    } else throw new Error("暂不传输特殊文件：" + local);
  }
  async function download(remote, local, depth = 0) {
    if (depth > 100) throw new Error("目录层级过深");
    const stat = await call(s, "lstat", remote);
    if (stat.isSymbolicLink()) throw new Error("暂不下载符号链接：" + remote);
    if (depth === 0 && expectedFileSize !== undefined &&
      (!stat.isFile() || stat.size !== expectedFileSize))
      throw new Error("拖放过程中远程文件已变化，请重试");
    await noLocalLink(local);
    if (stat.isDirectory()) {
      await fs.mkdir(local, { recursive: true });
      const entries = await call(s, "readdir", remote);
      const seen = new Set();
      for (const entry of entries) {
        if (entry.filename === "." || entry.filename === "..") continue;
        const name = safeName(entry.filename);
        const identity = name.toLowerCase();
        if (seen.has(identity))
          throw new Error("Windows 文件名大小写冲突：" + name);
        seen.add(identity);
        await download(
          path.posix.join(remote, name),
          path.join(local, name),
          depth + 1,
        );
      }
    } else if (stat.isFile()) {
      await call(s, "fastGet", remote, local, {
        step: (current, _chunk, total) => report(remote, current, total),
      });
      completed += stat.size;
      files++;
      report(remote, stat.size, stat.size);
    } else throw new Error("暂不下载特殊文件：" + remote);
  }
  if (action === "upload") await upload(local, remote);
  else if (action === "download") await download(remote, local);
  else throw new Error("未知传输操作");
  return { files, bytes: completed };
}
module.exports = { transferTree, safeName, validateRemoteRemoval, previewRemoteRemoval, removeRemote };

async function virtualDragManifest(sftp, remote) {
  const entries = [];
  async function visit(current, relative, depth = 0, attrs) {
    if (depth > 100 || entries.length >= 10000 || relative.length >= 260)
      throw new Error("目录过大或路径过长，请使用下载按钮");
    const stat = attrs?.mode ? attrs : await call(sftp, "lstat", current);
    const directory = stat.isDirectory();
    if (!directory && (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0))
      throw new Error("暂不拖出符号链接或特殊文件：" + relative);
    entries.push({ remote: current, name: relative, directory, size: directory ? 0 : stat.size });
    if (!directory) return;
    const seen = new Set();
    for (const entry of await call(sftp, "readdir", current)) {
      if (entry.filename === "." || entry.filename === "..") continue;
      const name = safeName(entry.filename);
      if (seen.has(name.toLowerCase())) throw new Error("Windows 文件名大小写冲突：" + name);
      seen.add(name.toLowerCase());
      await visit(path.posix.join(current, name), relative + "\\" + name, depth + 1, entry.attrs);
    }
  }
  await visit(remote, safeName(path.posix.basename(remote)));
  return entries;
}
module.exports.virtualDragManifest = virtualDragManifest;

async function relayTree(
  source,
  target,
  from,
  toDirectory,
  sameServer,
  progress,
) {
  const { pipeline } = require("node:stream/promises");
  const { posix } = path;
  const validName = (name) =>
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0");
  const name = posix.basename(from);
  if (!validName(name)) throw new Error("无效的远程文件名");
  const root = await call(target, "realpath", toDirectory);
  const destination = posix.join(root, name);
  if (sameServer) {
    const original = await call(source, "realpath", from);
    const relative = posix.relative(original, destination);
    if (!relative || (relative !== ".." && !relative.startsWith("../")))
      throw new Error("不能复制到原位置或源目录内部");
  }
  let files = 0,
    bytes = 0,
    lastReport = 0;
  async function copy(src, dst, depth) {
    if (depth > 100) throw new Error("目录层级过深");
    const stat = await call(source, "lstat", src);
    if (await remoteMissing(target, dst)) throw new Error("目标已存在：" + dst);
    if (stat.isDirectory()) {
      const entries = await call(source, "readdir", src);
      await call(target, "mkdir", dst);
      for (const { filename } of entries) {
        if (filename === "." || filename === "..") continue;
        if (!validName(filename)) throw new Error("不支持的远程文件名");
        await copy(
          posix.join(src, filename),
          posix.join(dst, filename),
          depth + 1,
        );
      }
      return;
    }
    if (!stat.isFile()) throw new Error("不支持复制符号链接或特殊文件：" + src);
    let current = 0,
      created = false;
    const input = source.createReadStream(src, { highWaterMark: 64 * 1024 });
    const output = target.createWriteStream(dst, {
      flags: "wx",
      highWaterMark: 64 * 1024,
    });
    output.once("open", () => {
      created = true;
    });
    input.on("data", (chunk) => {
      current += chunk.length;
      const now = Date.now();
      if (now - lastReport >= 150) {
        lastReport = now;
        progress({ name: dst, current, total: stat.size, files });
      }
    });
    try {
      await pipeline(input, output);
    } catch (error) {
      if (created) await call(target, "unlink", dst).catch(() => {});
      throw error;
    }
    bytes += current;
    files++;
  }
  await copy(from, destination, 0);
  return { files, bytes };
}
module.exports.relayTree = relayTree;
