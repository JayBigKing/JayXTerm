const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const settle = () => new Promise((r) => setTimeout(r, 250));
async function check(w, fixture) {
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
      `Array.from(document.querySelectorAll('.terminal-pane.active .xterm-rows > div'),r=>r.textContent.replace(/\u00a0/g,' ').trimEnd())`,
    );
  try {
    for (const width of [1380, 1050, 1500]) {
      w.setSize(width, 850);
      await settle();
      await w.webContents.executeJavaScript(
        "document.querySelector('.terminal-pane.active .xterm-helper-textarea').focus()",
      );
      const geometry = await w.webContents.executeJavaScript(
        `(()=>{const p=document.querySelector('.terminal-pane.active');return {cols:Number(p.dataset.cols),rows:Number(p.dataset.rows)}})()`,
      );
      assert.deepEqual(
        fixture.sizes.at(-1),
        geometry,
        "SSH PTY dimensions must match the visible terminal",
      );
      await insert(": PREVIOUS_LINE_SHOULD_REMAIN");
      await key("Enter", "Enter", 13);
      const command =
        ": WRAP_BEGIN_" + "x".repeat(geometry.cols * 2) + "_WRAP_END";
      await insert(command);
      const editing = await screen();
      assert.ok(
        editing.join("").includes(command),
        "long command must wrap without overwriting its beginning",
      );
      await key("Enter", "Enter", 13);
      const before = await screen();
      assert.ok(before.join("").includes("PREVIOUS_LINE_SHOULD_REMAIN"));
      for (let i = 0; i < 3; i++) {
        await key("ArrowUp", "ArrowUp", 38);
        await key("ArrowDown", "ArrowDown", 40);
        assert.deepEqual(
          await screen(),
          before,
          "up/down history redraw must preserve the previous line and current prompt",
        );
      }
      fs.writeFileSync(
        path.resolve(`.codex-cache/qa/readline-${width}.png`),
        (await w.webContents.capturePage()).toPNG(),
      );
      console.log(
        `PASS: Bash/readline long-command wrap and history redraw at ${geometry.cols}x${geometry.rows}`,
      );
    }
  } finally {
    w.webContents.debugger.detach();
  }
}
module.exports = { check };
