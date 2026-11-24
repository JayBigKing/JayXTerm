const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { installFinderDrag } = require("./finder-drag.cjs");

async function setup(t, download) {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "jayxterm-finder-"));
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const source = { id: 7, isDestroyed: () => false, send: () => {} };
  const busyTransfers = new Set();
  const remoteDrags = new Map();
  const token = "finder-relay-token";
  let promise;
  let downloads = 0;
  installFinderDrag({
    ipcMain,
    native: {
      arm: (_handle, name, directory, data, write) => {
        promise = { name, directory, data, write };
        return true;
      },
      publish: (local, target) => require("node:fs").renameSync(local, target),
    },
    windowFor: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) }),
    logFile: path.join(destination, "diagnostics", "finder-drag-last.json"),
    ensureOwner: (sender, id) => {
      assert.equal(sender, source);
      assert.equal(id, "source");
    },
    ready: () => true,
    request: async (input) => {
      assert.equal(busyTransfers.has("source"), true);
      downloads++;
      await download(input);
    },
    busyTransfers,
    createRemoteDrag: () => {
      remoteDrags.set(token, {});
      return token;
    },
    remoteDrags,
  });
  function arm(name, directory) {
    ipcMain.emit("finder-drag:arm", { sender: source }, { id: "source", path: "/home/jay/" + name, directory });
    assert.equal(handlers.get("local-drag:available")(), "finder");
    return promise;
  }
  return { destination, arm, token, remoteDrags, busyTransfers, downloads: () => downloads };
}

test("Finder drag exposes a file promise, and fetches the original bytes only on drop", async (t) => {
  const bytes = Buffer.from([0x61, 0x64, 0x73, 0x0a, 0x00, 0xff]);
  const f = await setup(t, ({ local, path, action }) => {
    assert.equal(action, "download");
    assert.equal(path, "/home/jay/test");
    return fs.writeFile(local, bytes);
  });
  const promise = f.arm("test", false);
  assert.equal(promise.name, "test");
  assert.equal(promise.directory, false);
  assert.equal(f.downloads(), 0);
  assert.equal(f.busyTransfers.size, 0);
  const payload = promise.data;
  assert.equal(payload.readUInt32LE(), payload.length - 4);
  assert.equal(payload.readUInt32LE(4), 1);
  const typeBytes = payload.readUInt32LE(8) * 2;
  assert.equal(payload.toString("utf16le", 12, 12 + typeBytes), "application/x-jayxterm-sftp");
  const tokenOffset = 12 + Math.ceil(typeBytes / 4) * 4;
  assert.equal(payload.readUInt32LE(tokenOffset), f.token.length);
  assert.equal(payload.toString("utf16le", tokenOffset + 4, tokenOffset + 4 + f.token.length * 2), f.token);

  const target = path.join(f.destination, "test");
  const completion = [];
  await promise.write(target, (error) => completion.push(error));
  assert.deepEqual(completion, [undefined]);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(f.remoteDrags.size, 0);
  assert.equal(f.busyTransfers.size, 0);
});

test("Finder directory drop keeps its hierarchy and cleans up after a failed download", async (t) => {
  let fail = false;
  const f = await setup(t, async ({ local }) => {
    await fs.mkdir(path.join(local, "empty"), { recursive: true });
    await fs.writeFile(path.join(local, "原始.txt"), "ads\n");
    if (fail) throw new Error("SFTP failed");
  });
  const target = path.join(f.destination, "folder");
  const promise = f.arm("folder", true);
  assert.equal(promise.directory, true);
  await promise.write(target, (error) => assert.equal(error, undefined));
  assert.equal(await fs.readFile(path.join(target, "原始.txt"), "utf8"), "ads\n");
  assert.deepEqual(await fs.readdir(path.join(target, "empty")), []);

  fail = true;
  const failure = path.join(f.destination, "failure");
  await f.arm("failure", true).write(failure, (error) => assert.match(error, /SFTP failed/));
  await assert.rejects(fs.stat(failure), { code: "ENOENT" });
  assert.equal((await fs.readdir(f.destination)).some((name) => name.startsWith(".jayxterm-drop-")), false);
  assert.equal(f.busyTransfers.size, 0);
});
