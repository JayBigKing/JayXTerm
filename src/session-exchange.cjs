const fs = require("node:fs");
const path = require("node:path");
const { isIP } = require("node:net");
const { userInfo } = require("node:os");
const { domainToASCII } = require("node:url");
const { crc32 } = require("node:zlib");
const iconv = require("iconv-lite");
const { validateSession } = require("./store.cjs");

const maxConfig = 1024 * 1024;
const maxArchive = 32 * maxConfig;
const maxRows = 1500;
const unsafeText = /[\x00-\x1f\x7f]/;

async function boundedBytes(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("文件超过导入大小限制");
      error.code = "IMPORT_SIZE_LIMIT";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function decode(bytes, legacy = false) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!legacy) throw new Error("OpenSSH 配置须使用 UTF-8 或带 BOM 的 UTF-16", { cause: error });
    return iconv.decode(bytes, "gbk");
  }
}

function hostname(raw) {
  const host = raw.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host)) return host.toLowerCase();
  // Check the original text before domainToASCII normalizes URL delimiters.
  if (!host || /[\s\x00-\x1f\x7f:/\\@?#%\[\]]/u.test(host)) return "";
  const ascii = domainToASCII(host);
  return /^[a-z\d_.-]{1,253}$/i.test(ascii) ? ascii.toLowerCase() : "";
}

function connection({ name, host, port = "22", username, group = "", encoding }) {
  if (!name.trim() || name.length > 255 || unsafeText.test(name) || group.length > 512 || unsafeText.test(group))
    throw new Error("会话名称或分组无效");
  const normalizedHost = hostname(host);
  if (!normalizedHost) throw new Error("缺少主机地址或地址无效");
  if (!username.trim() || username.length > 255 || unsafeText.test(username))
    throw new Error("缺少用户名或用户名无效");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("SSH 端口无效");
  return { name: name.trim(), host: normalizedHost, port: Number(port), username: username.trim(), group, encoding };
}

function words(line, number) {
  const match = /^\s*([\w]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) throw new Error(`OpenSSH 配置第 ${number} 行格式无效`);
  const args = [];
  let word = "", quoted = false, started = false;
  const value = match[2];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "#" && !quoted) break;
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (char === "\\" && ['"', "\\"].includes(value[i + 1])) {
      word += value[++i];
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quoted) throw new Error(`OpenSSH 配置第 ${number} 行的引号未闭合`);
  if (started) args.push(word);
  return [match[1].toLowerCase(), args];
}

function matchesPattern(host, pattern) {
  if (!/[*?]/.test(pattern)) return host === pattern;
  let h = 0, p = 0, star = -1, retry = 0;
  while (h < host.length) {
    if (pattern[p] === "?" || pattern[p] === host[h]) {
      h++;
      p++;
    } else if (pattern[p] === "*") {
      star = p++;
      retry = h;
    } else if (star >= 0) {
      p = star + 1;
      h = ++retry;
    } else return false;
  }
  return /^\**$/.test(pattern.slice(p));
}

function applies(host, patterns) {
  let positive = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (matchesPattern(host, pattern.slice(1))) return false;
    } else if (matchesPattern(host, pattern)) positive = true;
  }
  return positive;
}

const sshFields = new Set(["hostname", "port", "user", "proxyjump", "proxycommand",
  "identityfile", "certificatefile", "passwordauthentication", "canonicalizehostname", "preferredauthentications"]);
const sshLabels = {
  proxyjump: "ProxyJump", proxycommand: "ProxyCommand",
  identityfile: "IdentityFile", certificatefile: "CertificateFile",
  passwordauthentication: "PasswordAuthentication", canonicalizehostname: "CanonicalizeHostname",
  preferredauthentications: "PreferredAuthentications",
};
const accumulatingFields = new Set(["identityfile", "certificatefile"]);

function setSshOption(options, key, value) {
  if (!options.has(key) || (accumulatingFields.has(key) && options.get(key).toLowerCase() === "none"))
    options.set(key, value);
}

function parseOpenSsh(text, username = userInfo().username) {
  const blocks = [];
  const aliases = new Map();
  let block = { patterns: ["*"], options: new Map() };
  blocks.push(block);
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 12000) throw new Error("OpenSSH 配置行数过多，请分批导入");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:#|$)/.test(lines[i])) continue;
    const [key, args] = words(lines[i], i + 1);
    if (key === "include" || key === "match")
      throw new Error(`第 ${i + 1} 行包含 ${key === "include" ? "Include" : "Match"}，请先将要导入的 Host 段整理到独立配置文件`);
    if (key === "host") {
      if (!args.length || args.some((arg) => !arg || arg.length > 255 || unsafeText.test(arg)))
        throw new Error(`第 ${i + 1} 行的 Host 无效`);
      block = { patterns: args.map((arg) => arg.toLowerCase()), options: new Map() };
      blocks.push(block);
      for (const alias of args) {
        if (!/^[!*?]|[*?]/.test(alias) && !aliases.has(alias.toLowerCase()))
          aliases.set(alias.toLowerCase(), alias);
      }
      if (aliases.size > maxRows) throw new Error("会话数量过多，请分批导入");
    } else if (sshFields.has(key)) {
      if (!args.length || (args.length > 1 && key !== "proxycommand"))
        throw new Error(`OpenSSH 配置第 ${i + 1} 行参数无效`);
      setSshOption(block.options, key, args.join(" "));
    }
  }
  return [...aliases].map(([alias, name]) => {
    const settings = new Map();
    for (const { patterns, options } of blocks) {
      if (!options.size || !applies(alias, patterns)) continue;
      for (const [key, value] of options)
        setSshOption(settings, key, value);
    }
    const unsupported = [...settings].find(([key, value]) => {
      if (!Object.hasOwn(sshLabels, key)) return false;
      const normalized = value.toLowerCase();
      if (key === "passwordauthentication") return normalized === "no";
      if (key === "preferredauthentications") return !normalized.split(",").includes("password");
      if (key === "canonicalizehostname") return normalized !== "no";
      return normalized !== "none";
    });
    if (unsupported)
      return { name, reason: "需要当前版本不支持的 " + sshLabels[unsupported[0]] + " 设置" };
    try {
      return connection({
        name, host: (settings.get("hostname") ?? name).replaceAll("%h", name),
        port: settings.get("port"), username: settings.get("user") ?? username, encoding: "utf-8",
      });
    } catch (error) {
      return { name, reason: error.message };
    }
  });
}

function parseXshell(bytes, name, group) {
  const wanted = {
    connection: new Set(["host", "port", "protocol", "username", "method", "useproxy"]),
    "connection:authentication": new Set(["username", "method"]),
    terminal: new Set(["encoding"]),
  };
  const settings = new Map();
  try {
    let section = "";
    for (const line of decode(bytes, true).split(/\r\n|\n|\r/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) section = header[1].trim().toLowerCase();
      const assignment = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (!assignment || !Object.hasOwn(wanted, section)) continue;
      const key = assignment[1].toLowerCase();
      if (wanted[section].has(key)) settings.set(section + "." + key, assignment[2]);
    }
    if (!/^ssh2?$/i.test(settings.get("connection.protocol") || ""))
      throw new Error("仅支持导入 Xshell 的 SSH 会话");
    if (/^(1|yes|true)$/i.test(settings.get("connection.useproxy") || ""))
      throw new Error("使用 Xshell 代理，当前版本无法迁移");
    const methods = (settings.get("connection:authentication.method") || settings.get("connection.method") || "")
      .toLowerCase().split(/\s*,\s*/);
    if (methods.some((method) => /public.?key|gssapi|keyboard.?interactive/.test(method)) &&
        !methods.includes("password"))
      throw new Error("会话使用当前版本不支持的认证方式");
    const encoding = /^(?:gbk|gb2312|cp936|936)$/i.test(settings.get("terminal.encoding"))
      ? "gbk" : "utf-8";
    return connection({
      name, group, host: settings.get("connection.host") || "",
      port: settings.get("connection.port") || "22",
      username: settings.get("connection:authentication.username") || settings.get("connection.username") || "",
      encoding,
    });
  } catch (error) {
    return { name, reason: error.message };
  }
}

function zipTail(bytes) {
  // The archive reader allocates a table from the ZIP directory entry count.
  // Bound that count before asking it to parse any records.
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50 ||
        offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) continue;
    const count = bytes.readUInt16LE(offset + 10);
    if (bytes.readUInt32LE(offset + 4) !== 0 || count > 10000 ||
        count !== bytes.readUInt16LE(offset + 8) ||
        bytes.readUInt32LE(offset + 16) + bytes.readUInt32LE(offset + 12) > offset)
      break;
    return bytes.length - offset;
  }
  throw new Error("无法读取 Xshell 备份，压缩包已损坏或目录超出导入限制");
}

async function readImport(file, format) {
  const isArchive = format === "xshell" && path.extname(file).toLowerCase() !== ".xsh";
  const limit = isArchive ? maxArchive : maxConfig;
  if (!(await fs.promises.stat(file)).isFile()) throw new Error("请选择普通文件");
  const bytes = await boundedBytes(fs.createReadStream(file, { end: limit }), limit);
  if (format === "ssh") return parseOpenSsh(decode(bytes));
  if (!isArchive) return [parseXshell(bytes, path.basename(file).slice(0, -4), "")];

  const { files } = await require("unzipper").Open.buffer(bytes, { tailSize: zipTail(bytes) });
  const entries = files.filter((entry) => entry.type === "File" && /\.xsh$/i.test(entry.path));
  if (entries.length > maxRows) throw new Error("会话数量过多，请分批导入");
  let remaining = 16 * maxConfig;
  const rows = [];
  for (const entry of entries) {
    const filename = !entry.isUnicode && entry.path.includes("\ufffd")
      ? iconv.decode(entry.pathBuffer, "gbk") : entry.path;
    const parts = filename.split(/[/\\]/);
    const name = parts.pop().slice(0, -4);
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) continue;
    if (parts[0]?.toLowerCase() === "xshell") parts.shift();
    try {
      if (entry.uncompressedSize > maxConfig || entry.uncompressedSize > remaining)
        throw new Error("会话文件超过导入大小限制");
      const content = await boundedBytes(entry.stream(), Math.min(maxConfig, remaining));
      remaining -= content.length;
      if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc32)
        throw new Error("会话文件损坏");
      rows.push(parseXshell(content, name, parts.join(" / ")));
    } catch (error) {
      if (error.code === "IMPORT_SIZE_LIMIT") throw error;
      rows.push({ name, reason: "会话文件无法解压或超过导入大小限制" });
    }
  }
  return rows;
}

function endpoint(session) {
  return JSON.stringify([hostname(session.host), session.port, session.username]);
}

function previewImport(rows, sessions) {
  const byEndpoint = new Map();
  for (const { id, name, group, host, port, username, encoding, password } of sessions) {
    const key = endpoint({ host, port, username });
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push({ id, name, group, encoding, hasPassword: Boolean(password) });
  }
  const incoming = new Set();
  return rows.map((row) => {
    if (row.reason) return row;
    const key = endpoint(row);
    const duplicate = incoming.has(key);
    incoming.add(key);
    return { ...row, duplicate, matches: byEndpoint.get(key) || [] };
  });
}

function applyImport(rows, sessions, choices) {
  if (!Array.isArray(choices) || choices.length !== rows.length)
    throw new Error("导入选择已失效，请重新预览");
  const updates = new Map();
  const added = [];
  for (const [index, row] of rows.entries()) {
    const choice = choices[index];
    if (choice === "skip") continue;
    if (!row.reason && choice === "add") {
      added.push(validateSession(row));
    } else if (!row.reason && typeof choice === "string" && choice.startsWith("update:") &&
        row.matches.some((match) => match.id === choice.slice(7))) {
      const id = choice.slice(7);
      if (updates.has(id)) throw new Error("同一条已有会话只能选择更新一次");
      updates.set(id, row);
    } else {
      throw new Error("导入选择已失效，请重新预览");
    }
  }
  return {
    sessions: sessions.map((session) => {
      const row = updates.get(session.id);
      return row ? { ...session, name: row.name, group: row.group || session.group } : session;
    }).concat(added),
    added: added.length, updated: updates.size, skipped: rows.length - added.length - updates.size,
  };
}

function exportOpenSsh(sessions) {
  const used = new Set();
  const blocks = [];
  const aliasFor = (value) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64);
  const quote = (value) => '"' + value.replace(/["\\]/g, "\\$&") + '"';
  for (const session of sessions) {
    const host = hostname(session.host);
    if (!host || !session.username || unsafeText.test(session.username) ||
        !Number.isInteger(session.port) || session.port < 1 || session.port > 65535) continue;
    const base = aliasFor(session.name) || aliasFor(host) || "server";
    let alias = base;
    for (let suffix = 2; used.has(alias); suffix++) alias = base + "-" + suffix;
    used.add(alias);
    blocks.push(`Host ${alias}\n    HostName ${host}\n    Port ${session.port}\n    User ${quote(session.username)}\n`);
  }
  return { text: blocks.join("\n"), count: blocks.length, skipped: sessions.length - blocks.length };
}

module.exports = { readImport, parseOpenSsh, previewImport, applyImport, exportOpenSsh };
