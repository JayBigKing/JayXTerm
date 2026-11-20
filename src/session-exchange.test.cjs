const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { crc32, deflateRawSync } = require("node:zlib");
const { parseOpenSsh, readImport, previewImport, applyImport, exportOpenSsh } = require("./session-exchange.cjs");

function archive(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    local.copy(record, 6, 4, 28);
    record.writeUInt32LE(offset, 42);
    chunks.push(local, filename, compressed);
    directory.push(record, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.reduce((size, chunk) => size + chunk.length, 0), 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, eocd]);
}

test("OpenSSH aliases inherit ordered defaults, block unsafe directives and report unsupported settings", () => {
  const rows = parseOpenSsh(`Host build backup
  HostName = "%h.example.net"
  Port 2007
  PasswordAuthentication yes
Host build
  Port 22 # the first value applies
Host *.lab !restricted.lab
  User ops
Host test.lab restricted.lab
  HostName 192.0.2.1
Host jump
  ProxyJump gateway
Host *
  User fallback
`, "local");
  assert.deepEqual(rows.slice(0, 4).map(({ name, host, port, username }) => [name, host, port, username]), [
    ["build", "build.example.net", 2007, "fallback"],
    ["backup", "backup.example.net", 2007, "fallback"],
    ["test.lab", "192.0.2.1", 22, "ops"],
    ["restricted.lab", "192.0.2.1", 22, "fallback"],
  ]);
  assert.match(rows[4].reason, /ProxyJump/);
  assert.throws(() => parseOpenSsh("Match exec example"), /Match/);
  assert.throws(() => parseOpenSsh("Include ~/.ssh/config.d/*"), /Include/);
});

test("read compressed Xshell sessions and groups without exposing password or other files", async (t) => {
  const root = path.resolve(".codex-cache/tmp");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "session-import-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const data = Buffer.from("\ufeff[CONNECTION]\r\nHost=build.example.net\r\nPort=2007\r\nProtocol=SSH\r\n" +
    "[CONNECTION:AUTHENTICATION]\r\nUserName=ops\r\nPassword=ignored-ciphertext\r\n" +
    "[TERMINAL]\r\nEncoding=CP936\r\n", "utf16le");
  const file = path.join(directory, "backup.xts");
  await fs.writeFile(file, archive([
    ["Xshell/开发/构建.xsh", data],
    ["Xshell/旧服务器.xsh", Buffer.from("[CONNECTION]\nProtocol=TELNET")],
    ["../escape.xsh", data],
    ["other/key.pri", Buffer.from("ignored")],
  ]));
  const rows = await readImport(file, "xshell");
  assert.deepEqual(rows[0], {
    name: "构建", group: "开发", host: "build.example.net", port: 2007, username: "ops", encoding: "gbk",
  });
  assert.match(rows[1].reason, /SSH/);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /ignored/);
  await fs.writeFile(file, Buffer.from("not a zip"));
  await assert.rejects(readImport(file, "xshell"), /无法读取 Xshell 备份/);
});

test("explicit updates retain credentials and encoding; export creates unique safe aliases", () => {
  const original = { id: "existing", name: "构建", group: "开发", host: "build", port: 22,
    username: "ops", encoding: "gbk", password: "encrypted" };
  const imported = [
    { name: "build", group: "构建", host: "BUILD", port: 22, username: "ops", encoding: "utf-8" },
    { name: "build", group: "", host: "build", port: 22, username: "ops", encoding: "utf-8" },
  ];
  const preview = previewImport(imported, [original]);
  assert.equal(preview[1].duplicate, true);
  assert.equal(preview[0].matches[0].hasPassword, true);
  assert.doesNotMatch(JSON.stringify(preview), /encrypted/);
  const result = applyImport(preview, [original], ["update:existing", "add"]);
  assert.deepEqual(result.sessions[0], { ...original, name: "build", group: "构建" });
  assert.equal(result.sessions[1].password, undefined);
  assert.throws(() => applyImport(preview, [original], ["update:existing", "update:existing"]), /只能选择更新一次/);
  const exported = exportOpenSsh(result.sessions);
  assert.match(exported.text, /^Host build\n/);
  assert.match(exported.text, /\nHost build-2\n/);
  assert.doesNotMatch(exported.text, /encrypted|gbk/);
  assert.equal(parseOpenSsh(exported.text).length, 2);
});
