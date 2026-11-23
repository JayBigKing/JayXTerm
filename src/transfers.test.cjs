const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { safeName, transferTree, previewRemoteRemoval, removeRemote } = require("./transfers.cjs");
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
test("remote deletion rejects root/traversal and never follows symbolic links", async () => {
  const entries = new Map([
    ["/tree", "directory"], ["/tree/nested", "directory"],
    ["/tree/nested/中文 ' $().txt", "file"], ["/tree/link", "symlink"],
    ["/outside", "file"],
  ]);
  const removed = [];
  const sftp = {
    lstat(target, cb) {
      const kind = entries.get(target);
      cb(null, { isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "symlink" });
    },
    realpath: (target, cb) => cb(null, target),
    readdir(target, cb) {
      cb(null, [...entries.keys()].filter((entry) => path.posix.dirname(entry) === target)
        .map((entry) => ({ filename: path.posix.basename(entry) })));
    },
    unlink(target, cb) { removed.push(target); entries.delete(target); cb(); },
    rmdir(target, cb) {
      assert.ok(![...entries.keys()].some((entry) => path.posix.dirname(entry) === target));
      removed.push(target); entries.delete(target); cb();
    },
  };
  for (const target of ["/", "/tree/..", "/tree/", "/tree//nested", "tree", "/tree\0"])
    await assert.rejects(previewRemoteRemoval(sftp, target), /删除路径/);
  const preview = await previewRemoteRemoval(sftp, "/tree");
  assert.equal(preview.directory, true);
  assert.equal(preview.count, 4);
  entries.set("/tree", "file");
  await assert.rejects(removeRemote(sftp, "/tree", preview.revision), /已变化/);
  entries.set("/tree", "directory");
  entries.set("/tree/replacement.txt", "file");
  await assert.rejects(removeRemote(sftp, "/tree", preview.revision), /已变化/);
  assert.deepEqual(removed, []);
  assert.equal(entries.has("/tree/replacement.txt"), true);
  entries.delete("/tree/replacement.txt");
  assert.deepEqual(await removeRemote(sftp, "/tree", preview.revision), { files: 2, directories: 2 });
  assert.equal(entries.has("/outside"), true);
  assert.equal(removed.at(-1), "/tree");
});

test("remote deletion stops on changed parent paths and propagates permission errors", async () => {
  let unlinked = false;
  const sftp = {
    lstat: (_target, cb) => cb(null, { isDirectory: () => false, isSymbolicLink: () => false }),
    realpath: (target, cb) => cb(null, target),
    unlink: (_target, cb) => { unlinked = true; cb(new Error("Permission denied")); },
  };
  const { revision } = await previewRemoteRemoval(sftp, "/folder/file");
  sftp.realpath = (_target, cb) => cb(null, "/elsewhere");
  await assert.rejects(removeRemote(sftp, "/folder/file", revision), /父目录已变化/);
  assert.equal(unlinked, false);
  sftp.realpath = (target, cb) => cb(null, target);
  await assert.rejects(removeRemote(sftp, "/folder/file", revision), /Permission denied/);
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
