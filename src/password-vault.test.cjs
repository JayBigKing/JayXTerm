const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { openPasswordVault } = require("./password-vault.cjs");

function setup(t) {
  const temp = path.resolve(".codex-cache/tmp");
  fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, "vault-"));
  assert.equal(path.dirname(root), temp);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "quick-passwords.json"), key = randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-keyring",
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  return { file, storage, open: () => openPasswordVault(file, storage) };
}
test("named passwords persist encrypted and expose only descriptions until selected", t => {
  const { file, open } = setup(t);
  let vault = open();
  assert.deepEqual(vault.list(), { available: true, items: [] });
  const secret = " vm-1-密碼-1234 ";
  const entry = vault.save({ description: " 虚拟机1 ", password: secret }).items[0];
  assert.deepEqual(Object.keys(entry).sort(), ["description", "id"]);
  assert.equal(entry.description, "虚拟机1");
  assert.equal(fs.readFileSync(file, "utf8").includes(secret), false);
  assert.equal(JSON.stringify(vault.list()).includes(secret), false);
  vault = open();
  assert.equal(vault.reveal(entry.id), secret);
  vault.save({ id: entry.id, description: "开发虚拟机", password: "" });
  assert.equal(open().reveal(entry.id), secret);
  vault.save({ id: entry.id, description: "开发虚拟机", password: "new-secret-4567" });
  assert.equal(open().reveal(entry.id), "new-secret-4567");
  vault.remove(entry.id);
  assert.deepEqual(open().list().items, []);
  assert.throws(() => vault.reveal(entry.id), /已不存在/);
});
test("invalid vault edits and unavailable encryption never overwrite stored credentials", t => {
  const { file, storage, open } = setup(t);
  const vault = open();
  const first = vault.save({ description: "server", password: "keep-me" }).items[0];
  const before = fs.readFileSync(file, "utf8");
  for (const input of [null, {}, { description: "", password: "x" }, { description: "x".repeat(81), password: "x" },
    { description: "other", password: "" }, { description: "server", password: "x" },
    { description: "other", password: "hello\rcommand" }, { description: "other", password: "bad\x1b[A" },
    { id: "missing", description: "other", password: "x" }, { description: "other", password: "x".repeat(4097) }]) {
    assert.throws(() => vault.save(input));
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  storage.isEncryptionAvailable = () => false;
  assert.equal(vault.list().available, false);
  assert.throws(() => vault.save({ description: "other", password: "x" }), /系统安全存储/);
  assert.throws(() => vault.reveal(first.id), /系统安全存储/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
