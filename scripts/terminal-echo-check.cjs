const assert = require("node:assert/strict");

async function check(win, fixture) {
  const run = code => win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const pane = $('.terminal-pane.active');
    const overlay = pane.querySelector('.terminal-echo-preview');
    const wait = async test => {
      const limit = Date.now() + 6000;
      while (!test()) {
        if (Date.now() > limit) throw Error('Predictive echo timed out: ' + test);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    };
    ${code}
  })()`);
  const stream = [...fixture.streams][0];
  const saved = await run("return await window.api.settings();");
  const setEnabled = enabled => run(`$('#settings-open').click();
    await wait(() => $('#settings-dialog').open);
    $('#settings-predictive-echo').checked = ${enabled};
    $('#settings-form').requestSubmit();
    await wait(() => !$('#settings-dialog').open);`);
  const write = async text => { stream.write(text); await run("await new Promise(resolve => setTimeout(resolve, 60));"); };
  const type = async text => {
    await run("pane.querySelector('.xterm-helper-textarea').focus();");
    for (const char of text) {
      const before = fixture.inputs.length;
      win.webContents.sendInputEvent({ type: "char", keyCode: char });
      const deadline = Date.now() + 3000;
      while (fixture.inputs.length === before) {
        if (Date.now() > deadline) throw Error('Input did not reach the SSH fixture');
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
  };
  const preview = () => run("return overlay.hidden ? '' : overlay.textContent;");
  const confirmed = suffix => run(`await wait(() => pane.querySelector('.xterm-rows').textContent.trimEnd().endsWith(${JSON.stringify(suffix)}));`);
  async function train() {
    fixture.echo.enabled = true; fixture.echo.delay = 0; fixture.echo.transform = null;
    await write("\x1b[?1049l\x1b[?1l\x1b>\x1b[2J\x1b[H\x1b[?2004huser@host:~$ ");
    await type("e"); await confirmed("$ e");
    await type("c"); await confirmed("$ ec");
  }
  try {
    await setEnabled(true);
    await train();
    fixture.echo.delay = 350;
    const before = fixture.inputs.length;
    const started = Date.now();
    await type("h");
    await run("await wait(() => !overlay.hidden && overlay.textContent === 'h');");
    const localMs = Date.now() - started;
    assert.ok(localMs < 300, `Prediction waited for the delayed server: ${localMs}ms`);
    assert.ok(!(await run("return pane.querySelector('.xterm-rows').textContent.trimEnd().endsWith('ech');")),
      "Unconfirmed text must not enter terminal history");
    await type("o");
    await confirmed("$ echo");
    await run("await wait(() => overlay.hidden);");
    assert.equal(Buffer.concat(fixture.inputs.slice(before)).toString(), "ho", "Every key must still reach SSH exactly once");
    console.log(`Predictive echo displayed in ${localMs}ms with 350ms delayed remote output`);

    // A server rewrite wins immediately, with no local characters left behind.
    fixture.echo.transform = () => Buffer.from("\r\x1b[2Kserver correction");
    await type("x");
    assert.equal(await preview(), "x");
    await confirmed("server correction");
    assert.equal(await preview(), "");

    await train();
    fixture.echo.enabled = false;
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await write("\r\nPassword: ");
    await type("secret");
    assert.equal(await preview(), "", "Hidden passwords must never be predicted");

    await train();
    await write("\x1b[?1049h");
    fixture.echo.delay = 350;
    await type("vi");
    assert.equal(await preview(), "", "Alternate-screen programs must keep remote input semantics");
    await new Promise(resolve => setTimeout(resolve, 400));
    await train();
    await write("\x1b[?2004l");
    await type("h");
    assert.equal(await preview(), "", "Do not predict outside a shell's editing mode");

    for (const keyCode of ["Tab", "Left", "Backspace", "Escape"]) {
      console.log('Checking prediction reset for ' + keyCode);
      await train();
      fixture.echo.enabled = false;
      await type("h");
      assert.equal(await preview(), "h");
      const beforeKey = fixture.inputs.length;
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await run("await wait(() => overlay.hidden);");
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(fixture.inputs.length > beforeKey, keyCode + " must still reach the server");
      await type("z");
      assert.equal(await preview(), "", keyCode + " must reset confidence");
    }
    await train();
    fixture.echo.delay = 350;
    await type("中");
    assert.equal(await preview(), "", "CJK input must keep the server's cell widths");
    await confirmed("$ ec中");

    await train();
    fixture.echo.enabled = false;
    await type("h");
    assert.equal(await preview(), "h");
    await run("await wait(() => overlay.hidden);");
    await type("i");
    assert.equal(await preview(), "", "Missing acknowledgements must discard confidence");

    await train();
    await setEnabled(false);
    fixture.echo.delay = 350;
    await type("h");
    assert.equal(await preview(), "", "Settings must disable prediction in existing tabs");
    await confirmed("$ ech");
  } finally {
    fixture.echo.enabled = true; fixture.echo.delay = 0; fixture.echo.transform = null;
    await write("\x1b[?1049l\x1b[?2004l\r\n");
    await setEnabled(saved.predictiveEcho);
  }
}
module.exports = { check };
