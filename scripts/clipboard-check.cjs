const { clipboard, Menu } = require("electron");
const assert = require("node:assert/strict");
const iconv = require("iconv-lite");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(30);
  }
  throw new Error("Clipboard check timed out");
}
async function check(w, fixture) {
  const previous = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
  };
  if (previous.image.isEmpty()) delete previous.image;
  const id = await w.webContents.executeJavaScript("window.__qaConnectionId");
  const received = () => Buffer.concat(fixture.inputs);
  const screen = () =>
    w.webContents.executeJavaScript(
      `document.querySelector('.terminal-pane.active .xterm-rows').textContent`,
    );
  w.webContents.debugger.attach("1.3");
  const originalMenu = Menu.buildFromTemplate;
  let items;
  const key = async (key, code, virtual, modifiers) => {
    for (const type of ["keyDown", "keyUp"])
      await w.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: virtual,
        modifiers,
      });
  };
  const focus = () =>
    w.webContents.executeJavaScript(
      `document.querySelector('.terminal-pane.active .xterm-helper-textarea').focus()`,
    );
  const encoding = async (value) => {
    await w.webContents.executeJavaScript(
      `document.querySelector('#terminal-encoding').value=${JSON.stringify(value)};document.querySelector('#terminal-encoding').dispatchEvent(new Event('change'))`,
    );
    await waitFor(() =>
      w.webContents.executeJavaScript(
        `!document.querySelector('#terminal-encoding').disabled`,
      ),
    );
    await focus();
  };
  const menu = async () => {
    items = null;
    await w.webContents.executeJavaScript(
      `document.querySelector('.terminal-pane.active').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
    );
    await waitFor(() => !!items);
    for (const item of items) assert.equal(item.accelerator, undefined);
    return items;
  };
  const paste = async (text) => {
    clipboard.writeText(text);
    const before = received().length;
    (await menu())[1].click();
    await waitFor(() => received().length > before);
    await delay(100);
    return received().subarray(before);
  };
  try {
    Menu.buildFromTemplate = function (template) {
      const result = originalMenu.call(Menu, template);
      if (template[0]?.label === "复制") {
        items = template;
        result.popup = () => {};
      }
      return result;
    };
    w.show();
    w.focus();
    await focus();
    await w.webContents.executeJavaScript(
      `window.api.send({type:'input',id:${JSON.stringify(id)},data:'RIGHT_CLICK_COPY_中文\\r\\n'})`,
    );
    await waitFor(async () =>
      (await screen()).includes("RIGHT_CLICK_COPY_中文"),
    );
    let choices = await menu();
    assert.equal(choices[0].enabled, false);
    choices[3].click();
    await delay(100);
    choices = await menu();
    assert.equal(choices[0].enabled, true);
    clipboard.writeText("not copied yet");
    choices[0].click();
    await waitFor(() => clipboard.readText().includes("RIGHT_CLICK_COPY_中文"));
    // Selected text no longer turns Ctrl+C into a clipboard command.
    clipboard.writeText("CLIPBOARD_UNCHANGED");
    let before = received().length;
    await focus();
    await key("c", "KeyC", 67, 2);
    await waitFor(() => received().length > before);
    assert.deepEqual(received().subarray(before), Buffer.from([3]));
    assert.equal(clipboard.readText(), "CLIPBOARD_UNCHANGED");
    clipboard.writeText("NO_KEYBOARD_PASTE");
    before = received().length;
    await key("v", "KeyV", 86, 2);
    await waitFor(() => received().length > before);
    await delay(100);
    assert.deepEqual(
      received().subarray(before),
      Buffer.from([22]),
      "Ctrl+V must remain the terminal control key",
    );
    assert.deepEqual(
      await paste("右键UTF8中文粘贴"),
      Buffer.from("右键UTF8中文粘贴"),
    );
    await encoding("gbk");
    assert.deepEqual(
      await paste("右键GBK中文"),
      iconv.encode("右键GBK中文", "gbk"),
    );
    assert.ok((await screen()).includes("右键GBK中文"));
    [...fixture.streams][0].write("\x1b[?2004h");
    await delay(100);
    assert.deepEqual(
      await paste("第一行\r\n第二行\n第三行"),
      iconv.encode("\x1b[200~第一行\r第二行\r第三行\x1b[201~", "gbk"),
    );
    [...fixture.streams][0].write("\x1b[?2004l");
    await encoding("utf-8");
    console.log(
      "PASS: context-menu-only copy/paste, no menu accelerators, Ctrl+C/Ctrl+V retain terminal behavior, UTF-8/GBK and bracketed multiline paste",
    );
  } finally {
    Menu.buildFromTemplate = originalMenu;
    w.webContents.debugger.detach();
    clipboard.write(previous);
  }
}
module.exports = { check };
