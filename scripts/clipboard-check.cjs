const { clipboard, Menu, nativeImage } = require("electron");
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
  const initialSettings = await w.webContents.executeJavaScript("window.api.settings()");
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
  const settings = async (copyOnSelect, ctrlVPaste, save = true) => {
    await w.webContents.executeJavaScript(`(async () => {
      const $ = selector => document.querySelector(selector);
      $('#settings-open').click();
      for (let i = 0; i < 100 && !$('#settings-dialog').open; i++)
        await new Promise(resolve => setTimeout(resolve, 30));
      if (!$('#settings-dialog').open) throw Error('Clipboard settings did not open');
      $('#settings-tab-terminal').click();
      const form = $('#settings-form');
      form.elements.copyOnSelect.checked = ${copyOnSelect};
      form.elements.ctrlVPaste.checked = ${ctrlVPaste};
      if (${save}) form.requestSubmit();
      else $('#settings-cancel').click();
    })()`);
    await waitFor(() => w.webContents.executeJavaScript("!document.querySelector('#settings-dialog').open"));
    const saved = await w.webContents.executeJavaScript("window.api.settings()");
    if (save) {
      assert.equal(saved.copyOnSelect, copyOnSelect);
      assert.equal(saved.ctrlVPaste, ctrlVPaste);
    }
    await focus();
    return saved;
  };
  const selectText = "SELECT_中文😀";
  const dragSelection = async (beforeRelease) => {
    const points = await w.webContents.executeJavaScript(`(() => {
      const pane = document.querySelector('.terminal-pane.active');
      const screen = pane.querySelector('.xterm-screen').getBoundingClientRect();
      const row = [...pane.querySelectorAll('.xterm-rows > div')]
        .find(row => row.textContent.startsWith(${JSON.stringify(selectText)}));
      if (!row) throw Error('Selection test line is not visible');
      const line = row.getBoundingClientRect();
      const cell = screen.width / Number(pane.dataset.cols);
      return { x: screen.left + cell * 0.1, end: screen.left + cell * 13.1, y: line.top + line.height / 2 };
    })()`);
    const mouse = (type, x, buttons) => w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type, x, y: points.y, button: "left", buttons, clickCount: 1,
    });
    await mouse("mousePressed", points.x, 1);
    try {
      await mouse("mouseMoved", points.end, 1);
      await delay(80);
      await beforeRelease?.();
    } finally {
      await mouse("mouseReleased", points.end, 0);
    }
    await delay(100);
  };
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
  const keyboardPaste = async (text) => {
    clipboard.writeText(text);
    const before = received().length;
    await focus();
    await key("v", "KeyV", 86, 2);
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
    assert.equal(initialSettings.copyOnSelect, true);
    assert.equal(initialSettings.ctrlVPaste, true);
    await w.webContents.executeJavaScript(
      `window.api.send({type:'input',id:${JSON.stringify(id)},data:'RIGHT_CLICK_COPY_中文\\r\\n'})`,
    );
    await waitFor(async () =>
      (await screen()).includes("RIGHT_CLICK_COPY_中文"),
    );
    let choices = await menu();
    assert.equal(choices[0].enabled, false);
    clipboard.writeText("PROGRAMMATIC_SELECTION_MUST_NOT_COPY");
    choices[3].click();
    await delay(100);
    assert.equal(clipboard.readText(), "PROGRAMMATIC_SELECTION_MUST_NOT_COPY");
    choices = await menu();
    assert.equal(choices[0].enabled, true);
    clipboard.writeText("not copied yet");
    choices[0].click();
    await waitFor(() => clipboard.readText().includes("RIGHT_CLICK_COPY_中文"));
    [...fixture.streams][0].write("\r\n" + selectText + "\r\n");
    await waitFor(async () => (await screen()).includes(selectText));
    clipboard.writeText("WAIT_FOR_MOUSE_RELEASE");
    await dragSelection(() => assert.equal(clipboard.readText(), "WAIT_FOR_MOUSE_RELEASE"));
    await waitFor(() => clipboard.readText() === selectText);
    const notice = await w.webContents.executeJavaScript(`(() => {
      const notice = document.querySelector('#clipboard-notice');
      const bounds = notice.getBoundingClientRect();
      return { text: notice.textContent, hidden: notice.hidden,
        right: innerWidth - bounds.right, bottom: innerHeight - bounds.bottom,
        height: bounds.height, width: bounds.width, pointerEvents: getComputedStyle(notice).pointerEvents };
    })()`);
    assert.equal(notice.text, "已复制 10 字符", "Count Unicode characters, not UTF-16 code units");
    assert.equal(notice.hidden, false);
    assert.ok(notice.right <= 16 && notice.bottom <= 48 && notice.height <= 30 && notice.width < 180);
    assert.equal(notice.pointerEvents, "none");
    // Selected text no longer turns Ctrl+C into a clipboard command.
    clipboard.writeText("CLIPBOARD_UNCHANGED");
    let before = received().length;
    await focus();
    await key("c", "KeyC", 67, 2);
    await waitFor(() => received().length > before);
    assert.deepEqual(received().subarray(before), Buffer.from([3]));
    assert.equal(clipboard.readText(), "CLIPBOARD_UNCHANGED");
    assert.deepEqual(await keyboardPaste("键盘UTF8中文粘贴"), Buffer.from("键盘UTF8中文粘贴"));
    // An image-only clipboard must neither paste nor send terminal Ctrl+V.
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 }));
    assert.equal(clipboard.readText(), "");
    before = received().length;
    await key("v", "KeyV", 86, 2);
    await delay(180);
    assert.equal(received().length, before);
    await waitFor(() => w.webContents.executeJavaScript("document.querySelector('#clipboard-notice').hidden"));

    await settings(false, true);
    clipboard.writeText("AUTO_COPY_DISABLED");
    await dragSelection();
    assert.equal(clipboard.readText(), "AUTO_COPY_DISABLED");
    assert.equal(await w.webContents.executeJavaScript("document.querySelector('#clipboard-notice').hidden"), true);
    assert.deepEqual(await keyboardPaste("PASTE_STILL_ENABLED"), Buffer.from("PASTE_STILL_ENABLED"));
    const canceled = await settings(true, false, false);
    assert.equal(canceled.copyOnSelect, false);
    assert.equal(canceled.ctrlVPaste, true);

    await settings(true, false);
    await dragSelection();
    await waitFor(() => clipboard.readText() === selectText);
    clipboard.writeText("NO_KEYBOARD_PASTE");
    before = received().length;
    await key("v", "KeyV", 86, 2);
    await waitFor(() => received().length > before);
    await delay(100);
    assert.deepEqual(
      received().subarray(before),
      Buffer.from([22]),
      "Disabling Ctrl+V paste must restore the terminal control key",
    );
    await settings(false, false);
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
    await settings(true, true);
    assert.deepEqual(await keyboardPaste("键盘GBK中文"), iconv.encode("键盘GBK中文", "gbk"));
    [...fixture.streams][0].write("\x1b[?2004h");
    await delay(100);
    assert.deepEqual(
      await paste("第一行\r\n第二行\n第三行"),
      iconv.encode("\x1b[200~第一行\r第二行\r第三行\x1b[201~", "gbk"),
    );
    assert.deepEqual(
      await keyboardPaste("键盘第一行\r\n第二行\n第三行"),
      iconv.encode("\x1b[200~键盘第一行\r第二行\r第三行\x1b[201~", "gbk"),
    );
    [...fixture.streams][0].write("\x1b[?2004l");
    await encoding("utf-8");
    console.log(
      "PASS: mouse-release auto-copy, compact Unicode character notice, independent saved/canceled clipboard toggles, text-only Ctrl+V, terminal control keys, context menu and UTF-8/GBK bracketed paste",
    );
  } finally {
    Menu.buildFromTemplate = originalMenu;
    w.webContents.debugger.detach();
    clipboard.write(previous);
    await settings(initialSettings.copyOnSelect, initialSettings.ctrlVPaste);
  }
}
module.exports = { check };
