const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function check(w, fixture) {
  const log = path.resolve(".codex-cache/qa/local-drag.jsonl");
  const cache = path.resolve(".codex-cache/qa/profile/drag-out");
  await fs.rm(log, { force: true });
  await fs.rm(path.resolve(".codex-cache/qa/local-drag-relay-target"), { force: true });
  const data = Buffer.from([0, 255, 10, 13, 128]);
  fixture.files.set("/home/jay/local-drag.bin", data);
  fixture.files.set("/home/jay/row-drag.bin", data);
  fixture.files.set("/home/jay/mouse-drag.bin", data);
  fixture.files.set("/home/jay/cancel.bin", data);
  fixture.files.set("/home/jay/rejected.bin", data);
  for (const dir of ["drag-tree", "drag-tree/empty", "drag-tree/nested"])
    fixture.dirs.add("/home/jay/" + dir);
  fixture.files.set("/home/jay/drag-tree/nested/中文.bin", data);
  fixture.files.set("/home/jay/drag-tree/zero.txt", Buffer.alloc(0));

  const run = (code) => w.webContents.executeJavaScript(`(async () => {
    const wait = async (validate) => {
      for (let i = 0; i < 160; i++) {
        const result = validate();
        if (result) return result;
        await new Promise(r => setTimeout(r, 50));
      }
      throw Error('Local drag timed out: ' + document.querySelector('#transfer-status').textContent);
    };
    ${code}
  })()`);
  await run(`
    const path = document.querySelector('#remote-path');
    path.value = '/home/jay';
    path.form.requestSubmit();
    await wait(() => document.querySelector('#file-list .local-drag'));
    window.__qaLocalDragMessages = [];
    window.__qaLocalDragOff = window.api.onWindow(message => {
      if (message.type === 'local-drag-status') window.__qaLocalDragMessages.push(message.message);
    });
  `);
  w.webContents.debugger.attach("1.3");
  try {
    for (const [name, status, selector = ".local-drag"] of [["local-drag.bin", "本地拖放完成"],
      ["cancel.bin", "已取消本地拖放"], ["rejected.bin", "目标没有接受拖放"],
      ["drag-tree", "本地拖放完成"], ["mouse-drag.bin", "本地拖放完成", ".filename"]]) {
      const box = await run(`
      const grip = () => [...document.querySelectorAll('#file-list .file-row')]
        .find(row => row.querySelector('.filename').textContent === ${JSON.stringify(name)})?.querySelector(${JSON.stringify(selector)});
       const button = await wait(grip);
       button.scrollIntoView({ block: 'nearest' });
       button.id = 'qa-local-drag-grip';
       window.__qaLocalDragMessages = [];
       const rect = button.getBoundingClientRect();
       return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
      `);
      const mouse = (type, x, buttons) => w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type, x, y: box.y, button: "left", buttons, clickCount: 1,
      });
      await mouse("mousePressed", box.x, 1);
      if (selector === ".local-drag") await run(`
        const button = document.querySelector('#qa-local-drag-grip');
        button.removeAttribute('id');
        const event = new DragEvent('dragstart', {bubbles: true, cancelable: true,
          dataTransfer: new DataTransfer()});
        button.closest('.file-row').dispatchEvent(event);
        if (!event.defaultPrevented) throw Error('The SFTP row took over the local grip gesture');
      `);
      else await run(`
        const filename = document.querySelector('#qa-local-drag-grip');
        filename.removeAttribute('id');
        window.__qaFileDragStarted = false;
        filename.closest('.file-row').addEventListener('dragstart', event => {
          window.__qaFileDragStarted = event.defaultPrevented;
        }, { once: true });
      `);
      await mouse("mouseMoved", box.x + 12, 1);
      await mouse("mouseReleased", box.x + 12, 0);
      await run(`await wait(() => window.__qaLocalDragMessages.some(message => message.startsWith(${JSON.stringify(status)})));`);
      if (selector === ".filename")
        assert.equal(await run("return window.__qaFileDragStarted;"), true, "Mouse file-name drag did not start native drag");
    }
  } finally {
    w.webContents.debugger.detach();
    await run("window.__qaLocalDragOff(); delete window.__qaLocalDragOff; delete window.__qaLocalDragMessages;");
  }
  await run(`
    const row = [...document.querySelectorAll('#file-list .file-row')]
      .find(row => row.querySelector('.filename').textContent === 'row-drag.bin');
    const data = new DataTransfer();
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data });
    let completed = false;
    const off = window.api.onWindow(message => {
      if (message.type === 'local-drag-status' && message.message === '本地拖放完成') completed = true;
    });
    try {
      row.querySelector('.filename').dispatchEvent(event);
      if (!event.defaultPrevented)
        throw Error('File-name drag did not start native file drag; offered formats: ' + data.types.join(', '));
      await wait(() => completed);
    } finally { off(); }
  `);
  const results = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(results.map((result) => result.status), ["copy", "cancelled", "rejected", "copy", "copy", "copy"]);
  assert.deepEqual(results[0].files, [{ name: "local-drag.bin", bytes: data.toString("hex") }]);
  assert.deepEqual(results[1].files, []);
  assert.deepEqual(results[2].files, []);
  assert.deepEqual(results[3].entries, [
    { name: "drag-tree", directory: true, size: 0 },
    { name: "drag-tree\\empty", directory: true, size: 0 },
    { name: "drag-tree\\nested", directory: true, size: 0 },
    { name: "drag-tree\\nested\\中文.bin", directory: false, size: data.length },
    { name: "drag-tree\\zero.txt", directory: false, size: 0 },
  ]);
  assert.deepEqual(results[3].files, [{ name: "drag-tree\\nested\\中文.bin", bytes: data.toString("hex") }]);
  assert.deepEqual(results[4].files, [{ name: "mouse-drag.bin", bytes: data.toString("hex") }]);
  assert.match(results[4].relayText, /^jayxterm-sftp:[\da-f-]+$/);
  assert.deepEqual(results[5].files, [{ name: "row-drag.bin", bytes: data.toString("hex") }]);
  assert.match(results[5].relayText, /^jayxterm-sftp:[\da-f-]+$/);
  w.webContents.send("ssh:event", {
    type: "progress", id: await run("return window.__qaConnectionId;"),
    files: 1, name: "/home/jay/row-drag.bin", current: data.length, total: data.length,
  });
  await run(`
    await new Promise(resolve => setTimeout(resolve, 50));
    if (document.querySelector('#transfer-status').textContent !== '本地拖放完成')
      throw Error('Late progress overwrote native drag completion: ' + document.querySelector('#transfer-status').textContent);
  `);
  for (let i = 0; i < 40 && (await fs.readdir(cache)).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await fs.readdir(cache), []);
  console.log("PASS: file-name mouse drag, native relay tokens, local drag streams, cancellation, nested and empty entries, staging cleanup");
}

module.exports = { check };
