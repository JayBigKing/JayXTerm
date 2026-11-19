const fs = require("node:fs");
const path = require("node:path");
const { normalizeEncoding } = require("./codec.cjs");
const { randomUUID } = require("node:crypto");
function validateSession(s) {
  const result = {
    id: s.id || randomUUID(),
    name: String(s.name || "").trim(),
    host: String(s.host || "").trim(),
    port: Number(s.port ?? 22),
    username: String(s.username || "").trim(),
    group: String(s.group || "").trim(),
    encoding: normalizeEncoding(s.encoding),
  };
  if (
    !result.name ||
    !result.host ||
    !result.username ||
    !Number.isInteger(result.port) ||
    result.port < 1 ||
    result.port > 65535
  )
    throw new Error("请填写名称、主机、用户名和有效端口");
  return result;
}
function openStore(file) {
  let data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { sessions: [], hosts: {} };
  return {
    get: () => data,
    write(next) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".new", JSON.stringify(next, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(file + ".new", file);
      data = next;
    },
  };
}
module.exports = { validateSession, openStore };
