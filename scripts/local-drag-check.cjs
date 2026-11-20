const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function check(w, fixture) {
  const log = path.resolve(".codex-cache/qa/local-drag.jsonl");
  const cache = path.resolve(".codex-cache/qa/profile/drag-out");
  await fs.rm(log, { force: true });
  const data = Buffer.from([0, 255, 10, 13, 128]);
  fixture.files.set("/home/jay/local-drag.bin", data);
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
  `);
  w.webContents.debugger.attach("1.3");
  try {
    for (const [name, status] of [["local-drag.bin", "本地拖放完成"],
      ["cancel.bin", "已取消本地拖放"], ["rejected.bin", "目标没有接受拖放"],
      ["drag-tree", "本地拖放完成"]]) {
      const box = await run(`
      const grip = () => [...document.querySelectorAll('#file-list .file-row')]
        .find(row => row.querySelector('.filename').textContent === ${JSON.stringify(name)})?.querySelector('.local-drag');
       const button = await wait(grip);
       button.scrollIntoView({ block: 'nearest' });
       button.id = 'qa-local-drag-grip';
       const rect = button.getBoundingClientRect();
       return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
      `);
      const mouse = (type, x, buttons) => w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type, x, y: box.y, button: "left", buttons, clickCount: 1,
      });
      await mouse("mousePressed", box.x, 1);
      await run(`
        const button = document.querySelector('#qa-local-drag-grip');
        button.removeAttribute('id');
        const event = new DragEvent('dragstart', {bubbles: true, cancelable: true,
          dataTransfer: new DataTransfer()});
        button.closest('.file-row').dispatchEvent(event);
        if (!event.defaultPrevented) throw Error('The SFTP row took over the local grip gesture');
      `);
      await mouse("mouseMoved", box.x + 12, 1);
      await mouse("mouseReleased", box.x + 12, 0);
      await run(`await wait(() => document.querySelector('#transfer-status').textContent.startsWith(${JSON.stringify(status)}));`);
    }
  } finally {
    w.webContents.debugger.detach();
  }
  const results = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(results.map((result) => result.status), ["copy", "cancelled", "rejected", "copy"]);
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
  for (let i = 0; i < 40 && (await fs.readdir(cache)).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await fs.readdir(cache), []);
  console.log("PASS: local drag stream requests, cancellation, nested and empty entries, staging cleanup");
}

module.exports = { check };
