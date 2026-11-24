const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { installLocalDrag } = require("./local-drag.cjs");

// A real pipe peer, with its drop controlled by the test instead of a mouse.
const helperSource = `
  const fs = require('node:fs');
  const readline = require('node:readline');
  const [commandPath, releasePath] = process.argv.slice(1);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const command = line.split('\t');
    if (command[0] !== 'drag') return;
    fs.writeFileSync(commandPath, JSON.stringify(command));
    const timer = setInterval(() => {
      if (!fs.existsSync(releasePath)) return;
      clearInterval(timer);
      const status = fs.readFileSync(releasePath, 'utf8');
      if (status === 'exit') process.exit(1);
      console.log('done\t' + command[1] + '\t' + status);
    }, 10);
  });
`;

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jayxterm-local-drag-"));
  const commandPath = path.join(directory, "command.json");
  const releasePath = path.join(directory, "release.txt");
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const messages = [];
  const sender = { id: 7, isDestroyed: () => false, send: (_channel, message) => messages.push(message) };
  const busyTransfers = new Set();
  const remoteDrags = new Map();
  const token = "test-token";
  const drag = { id: "source", remote: "/data/file.bin", owner: sender.id, expires: Date.now() + 120000 };
  remoteDrags.set(token, drag);
  const stop = installLocalDrag({
    ipcMain,
    helper: { file: process.execPath, args: ["-e", helperSource, commandPath, releasePath] },
    tempRoot: path.join(directory, "staging"),
    ensureOwner: (window, id) => { assert.equal(window, sender); assert.equal(id, "source"); },
    ready: () => true,
    request: () => { throw Error("An internal drag must not download file contents"); },
    busyTransfers,
    remoteDrags,
  });
  t.after(async () => {
    stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const start = (request = {}) => ipcMain.emit("local-drag:start", { sender }, {
    id: "source", path: "/data/file.bin", token, ...request,
  });
  async function command() {
    for (let i = 0; i < 200; i++) {
      try { return JSON.parse(await fs.readFile(commandPath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("Drag helper did not receive the command");
  }
  async function release(status) {
    const pending = releasePath + ".new";
    await fs.writeFile(pending, status);
    await fs.rename(pending, releasePath);
  }
  return { start, command, release,
    busyTransfers, remoteDrags, token, drag, messages };
}

test("native row drag preserves the relay token and releases the source before relay resumes", { timeout: 5000 }, async (t) => {
  const f = await setup(t);
  f.start();
  assert.equal(f.busyTransfers.has("source"), true);
  const command = await f.command();
  assert.deepEqual(command.slice(0, 2), ["drag", f.token]);
  assert.equal(Buffer.from(command[2], "base64").toString(), "jayxterm-sftp:" + f.token);
  let resumed = false;
  const relay = f.drag.nativeDrop.then((status) => {
    assert.equal(status, "copy");
    assert.equal(f.busyTransfers.has("source"), false);
    resumed = true;
  });
  await new Promise(setImmediate);
  assert.equal(resumed, false, "The helper has not finished its drop yet");
  f.drag.claimed = true;
  f.remoteDrags.delete(f.token);
  await f.release("copy");
  await relay;
  assert.equal(resumed, true);
  assert.ok(!f.messages.some(({ message }) => message === "本地拖放完成"),
    "Native completion must not overwrite the internal relay's progress");
  assert.equal(f.messages.at(-1).active, false, "An internal drop must also clear the source's native drag state");
});

test("unsuccessful native drags revoke their relay token and unlock the source", { timeout: 10000 }, async (t) => {
  for (const status of ["cancelled", "rejected", "released", "failed", "exit"]) {
    await t.test(status, async (t) => {
      const f = await setup(t);
      f.start();
      await f.command();
      await f.release(status);
      assert.equal(await f.drag.nativeDrop, status === "exit" ? "failed" : status);
      assert.equal(f.busyTransfers.size, 0);
      assert.equal(f.remoteDrags.has(f.token), false);
    });
  }
});

test("internal drag keeps POSIX names that cannot be copied to Windows", { timeout: 5000 }, async (t) => {
  const f = await setup(t);
  f.drag.remote = "/data/report:latest.bin";
  f.start({ path: f.drag.remote });
  await f.command();
  await f.release("copy");
  assert.equal(await f.drag.nativeDrop, "copy");
  assert.equal(f.busyTransfers.size, 0);
});

test("native drag rejects forged, expired, mismatched and reused relay tokens", async (t) => {
  const f = await setup(t);
  f.start({ token: "unknown" });
  assert.match(f.messages.at(-1).message, /拖放已失效/);
  for (const changed of [{ id: "other" }, { remote: "/data/other.bin" },
    { owner: 8 }, { expires: 0 }, { nativeDrop: Promise.resolve("copy") }]) {
    const invalid = { ...f.drag, ...changed };
    f.remoteDrags.set(f.token, invalid);
    f.start();
    assert.match(f.messages.at(-1).message, /拖放已失效/);
    assert.equal(f.busyTransfers.size, 0);
    assert.equal(invalid.nativeDrop, changed.nativeDrop);
  }
});
