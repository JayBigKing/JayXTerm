const fs = require("node:fs/promises");
const path = require("node:path");
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
async function transferTree(s, action, local, remote, progress = () => {}) {
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
module.exports = { transferTree, safeName };

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
