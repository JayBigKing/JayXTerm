const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { BrowserWindow } = require("electron");

async function check(win, fixture) {
  const run = (code) => win.webContents.executeJavaScript(`(async () => {
    const $ = (selector) => document.querySelector(selector);
    const wait = async (check) => {
      for (let i = 0; i < 150; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('Terminal settings timed out: ' + check + ' / ' + $('#settings-error').textContent);
    };
    const open = async () => { $('#settings-open').click(); await wait(() => $('#settings-dialog').open); };
    const fontSize = () => getComputedStyle($('.terminal-pane.active .xterm-rows')).fontSize;
    const columns = () => Number($('.terminal-pane.active').dataset.cols);
    ${code}
  })()`);
  const initial = await run("return await api.settings();");
  const source = await run("return $('.tab.active').dataset.connection;");
  const previousEncoding = await run("return $('#terminal-encoding').value;");
  const restoreWindow = process.platform === "win32" && !win.isMinimized();
  let other, newSession;
  try {
    // Reproduce Windows CI's background state: font previews and terminal
    // resizing must still finish when the workspace is minimized.
    if (restoreWindow) {
      const minimized = once(win, "minimize");
      win.minimize();
      await minimized;
      console.log("Checking terminal settings with the workspace minimized");
    }
    await run(`
      window.__initialColumns = columns();
      const otherFont = getComputedStyle($('.sidebar')).fontSize;
      await open();
      if (document.querySelectorAll('.settings-nav [role=tab]').length !== 4) throw new Error('Missing settings categories');
      $('#settings-tab-appearance').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      if ($('#settings-terminal').hidden || document.activeElement.id !== 'settings-tab-terminal') throw new Error('Keyboard category navigation failed');
      $('#settings-font-family').value = 'Consolas';
      $('#settings-font-size').value = '22';
      $('#settings-font-size').dispatchEvent(new Event('input'));
      await wait(() => fontSize() === '22px' && columns() < window.__initialColumns);
      if (getComputedStyle($('.sidebar')).fontSize !== otherFont) throw new Error('Font setting changed the app UI');
      $('#settings-tab-files').click();
      $('#settings-tab-terminal').click();
      if ($('#settings-font-size').value !== '22') throw new Error('Section switch lost the draft');
      $('#settings-cancel').click();
      await wait(() => fontSize() === '14px' && columns() === window.__initialColumns);
      await open();
      $('#settings-tab-terminal').click();
      $('#settings-font-family').value = 'Consolas';
      $('#settings-font-size').value = '20';
      $('#settings-font-size').dispatchEvent(new Event('input'));
      $('#settings-default-encoding').value = 'gb2312';
      $('#settings-save').click();
      await wait(() => !$('#settings-dialog').open && fontSize() === '20px');
      const saved = await api.settings();
      if (saved.fontFamily !== 'Consolas' || saved.fontSize !== 20 || saved.defaultEncoding !== 'gb2312') throw new Error('Terminal preferences not persisted');
      if ($('#terminal-encoding').value !== ${JSON.stringify(previousEncoding)}) throw new Error('Default encoding changed a live connection');
      $('#new').click();
      await wait(() => $('#editor').open);
      if ($('#session-form').elements.encoding.value !== 'gb2312') throw new Error('New session did not inherit the default encoding');
      $('#editor-cancel').click();
    `);
    const persisted = JSON.parse(fs.readFileSync(".codex-cache/qa/profile/settings.json", "utf8"));
    assert.equal(persisted.fontSize, 20);
    assert.equal(persisted.defaultEncoding, "gb2312");
    // A separate workspace must pick up saved defaults and apply them to newly created terminals.
    newSession = await run(`
      const original = (await api.sessions()).find(session => session.name === '本地验收服务器');
      const { id, encoding, ...input } = original;
      const saved = await api.save({ ...input, name: '字体编码验收', remember: true, password: 'qa-password' });
      return saved.find(session => session.name === '字体编码验收');
    `);
    assert.equal(newSession.encoding, "gb2312");
    const otherId = await run("return await api.newWindow();");
    other = BrowserWindow.getAllWindows().find((item) => item.webContents.id === otherId);
    await other.frontendReady;
    await other.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 150; i++) {
        const row = [...document.querySelectorAll('.session')].find(item => item.textContent.includes('字体编码验收'));
        if (row) { row.querySelector('button').click(); break; }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      for (let i = 0; i < 150; i++) {
        const rows = document.querySelector('.terminal-pane.active .xterm-rows');
        if (document.querySelector('#status').textContent.includes('已连接') && rows) {
          if (getComputedStyle(rows).fontSize !== '20px' || !getComputedStyle(rows).fontFamily.includes('Consolas')) throw new Error('New terminal ignored the font');
          if (document.querySelector('#terminal-encoding').value !== 'gb2312') throw new Error('New terminal ignored GB2312');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('New terminal did not connect');
    })()`);
    await run(`await open(); $('#settings-tab-terminal').click();
      await wait(() => !$('#settings-terminal').hidden);
      await new Promise(resolve => setTimeout(resolve, 180));`);
    fs.writeFileSync(path.resolve(".codex-cache/qa/settings-terminal.png"), (await win.webContents.capturePage()).toPNG());
    await run(`$('#settings-default-font').click(); $('#settings-save').click();
      await wait(() => !$('#settings-dialog').open && fontSize() === '14px');`);
    await other.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 150; i++) {
        if (getComputedStyle(document.querySelector('.terminal-pane.active .xterm-rows')).fontSize === '14px') return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('Font reset was not broadcast');
    })()`);
    const start = fixture.inputs.length;
    await run(`
      $('#terminal-encoding').value = 'gb2312';
      $('#terminal-encoding').dispatchEvent(new Event('change'));
      await wait(() => !$('#terminal-encoding').disabled && $('#terminal-encoding').value === 'gb2312');
      api.send({ type: 'input', id: ${JSON.stringify(source)}, data: '中文测试' });
      await wait(() => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].some(row => row.textContent.includes('中文测试')));
    `);
    assert.ok(Buffer.concat(fixture.inputs.slice(start)).includes(Buffer.from("d6d0cec4b2e2cad4", "hex")));
    await run(`await open(); $('#settings-tab-terminal').click();
      $('#settings-font-size').value = '100';
      $('#settings-tab-appearance').click(); $('#settings-save').click();
      if (!$('#settings-dialog').open || $('#settings-terminal').hidden) throw new Error('Invalid hidden font field was not shown');
      $('#settings-cancel').click();`);
    console.log("PASS: settings categories, terminal font preview/cancel/save/reset, resizing, cross-window sync and GB2312 SSH input/output");
  } finally {
    if (restoreWindow && !win.isDestroyed()) win.restore();
    if (other && !other.isDestroyed()) {
      await other.webContents.executeJavaScript("document.querySelector('.tab .close')?.click();");
      other.allowClose = true;
      other.close();
    }
    if (newSession) await run(`await api.remove(${JSON.stringify(newSession.id)});`);
    await run(`
      const saved = ${JSON.stringify(initial)};
      await open();
      const form = $('#settings-form');
      for (const name of ['fontFamily', 'fontSize', 'defaultEncoding']) form.elements[name].value = saved[name];
      form.requestSubmit();
      await wait(() => !$('#settings-dialog').open);
      $('#terminal-encoding').value = ${JSON.stringify(previousEncoding)};
      $('#terminal-encoding').dispatchEvent(new Event('change'));
      await wait(() => !$('#terminal-encoding').disabled);
    `);
  }
}
module.exports = { check };
