const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const iconv = require("iconv-lite");
const settle = () => new Promise((r) => setTimeout(r, 300));
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
async function check(w, fixture) {
  const file = path.resolve(".codex-cache/qa/vim-gbk.txt");
  fs.writeFileSync(
    file,
    iconv.encode("中文GBK文件第一行\n第二行内容\n", "gbk"),
  );
  w.webContents.debugger.attach("1.3");
  const key = async (key, code, virtual) => {
    for (const type of ["keyDown", "keyUp"])
      await w.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: virtual,
      });
    await settle();
  };
  const insert = async (text) => {
    await w.webContents.debugger.sendCommand("Input.insertText", { text });
    await settle();
  };
  const screen = () =>
    w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.terminal-pane.active .xterm-rows > div'),r=>r.textContent).join(String.fromCharCode(10))`,
    );
  const encoding = async (value) => {
    await w.webContents.executeJavaScript(
      `document.querySelector('#terminal-encoding').value=${JSON.stringify(value)};document.querySelector('#terminal-encoding').dispatchEvent(new Event('change'))`,
    );
    await settle();
    await w.webContents.executeJavaScript(
      `(async()=>{const s=(await window.api.sessions()).find(s=>s.name==='本地验收服务器');if(s.encoding!==${JSON.stringify(value)})throw new Error('Encoding preference was not saved');document.querySelector('.terminal-pane.active .xterm-helper-textarea').focus();})()`,
    );
  };
  const run = async (command) => {
    await insert(command);
    await key("Enter", "Enter", 13);
    await settle();
  };
  try {
    await encoding("gbk");
    await run("cat " + quote(file));
    assert.ok(
      (await screen()).includes("中文GBK文件第一行"),
      "GBK cat should be readable",
    );
    await run(
      "vim -Nu NONE -n -i NONE --cmd 'set encoding=utf-8 termencoding=utf-8 fileencodings=cp936' " +
        quote(file),
    );
    assert.ok(
      !(await screen()).includes("中文GBK文件第一行"),
      "mismatched Vim terminal encoding should reproduce garbling",
    );
    fs.writeFileSync(
      path.resolve(".codex-cache/qa/vim-mismatch.png"),
      (await w.webContents.capturePage()).toPNG(),
    );
    await key("Escape", "Escape", 27);
    await run(":set termencoding=cp936 | redraw!");
    assert.ok(
      (await screen()).includes("中文GBK文件第一行"),
      "Vim CP936 display should be readable",
    );
    await insert("i");
    await insert("新增中文");
    await key("Escape", "Escape", 27);
    assert.ok(
      (await screen()).includes("新增中文中文GBK文件第一行"),
      "Chinese insertion must round trip through GBK",
    );
    fs.writeFileSync(
      path.resolve(".codex-cache/qa/vim-gbk.png"),
      (await w.webContents.capturePage()).toPNG(),
    );
    if (process.env.JAYXTERM_MULTIWINDOW_QA === "1")
      await require("./multiwindow-check.cjs").roundTrip(w, fixture);
    await run(":wq");
    assert.ok(
      iconv
        .decode(fs.readFileSync(file), "gbk")
        .startsWith("新增中文中文GBK文件第一行"),
    );
    assert.ok(
      !fs
        .readFileSync(file)
        .equals(
          Buffer.from(iconv.decode(fs.readFileSync(file), "gbk"), "utf8"),
        ),
      "Vim must preserve GBK file bytes",
    );
    await encoding("utf-8");
    await run(
      "vim -Nu NONE -n -i NONE --cmd 'set encoding=utf-8 termencoding=utf-8 fileencodings=cp936' " +
        quote(file),
    );
    assert.ok(
      (await screen()).includes("新增中文中文GBK文件第一行"),
      "UTF-8 terminal must also support reading GBK files in Vim",
    );
    await run(":q!");
    console.log(
      "PASS: GBK cat, reproduced Vim encoding mismatch, GBK Vim display/input/save, and UTF-8 Vim reading GBK files",
    );
  } finally {
    w.webContents.debugger.detach();
  }
}
module.exports = { check };
