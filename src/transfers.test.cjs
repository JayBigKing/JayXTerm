const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { safeName, transferTree } = require("./transfers.cjs");
test("remote names cannot escape or overwrite Windows device paths", () => {
  for (const name of [
    "..",
    "../secret",
    "a\\b",
    "CON",
    "con.txt",
    "LPT1.log",
    "file:stream",
    "trailing.",
    "trailing ",
  ])
    assert.throws(() => safeName(name));
  assert.equal(safeName("中文.txt"), "中文.txt");
});
test("recursive download rejects symlinks and case collisions", async () => {
  const dir = await fs.mkdtemp(path.resolve(".codex-cache/tmp/transfer-"));
  try {
    const linked = {
      lstat: (_p, cb) => cb(null, { isSymbolicLink: () => true }),
    };
    await assert.rejects(
      transferTree(linked, "download", path.join(dir, "linked"), "/link"),
      /符号链接/,
    );
    const duplicate = {
      lstat: (_p, cb) =>
        cb(null, { isSymbolicLink: () => false, isDirectory: () => true }),
      readdir: (_p, cb) => cb(null, [{ filename: "Foo" }, { filename: "foo" }]),
    };
    let count = 0;
    duplicate.lstat = (_p, cb) => {
      count++;
      cb(null, {
        isSymbolicLink: () => false,
        isDirectory: () => count === 1,
        isFile: () => true,
        size: 0,
      });
    };
    duplicate.fastGet = (_r, _l, _o, cb) => cb(null);
    await assert.rejects(
      transferTree(duplicate, "download", path.join(dir, "case"), "/case"),
      /大小写冲突/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
