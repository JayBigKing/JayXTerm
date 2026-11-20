const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserWindow, dialog } = require("electron");
const { encode } = require("iconv-lite");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(40); }
  throw new Error("Quick password check timed out: " + check);
}

async function check(win, fixture) {
  function press(keyCode) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  }
  const run = code => win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const wait = async (check, label) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('Quick passwords timed out: ' + (label || check) + ' / ' + $('#quick-password-error').textContent + ' / ' + $('#vault-note').textContent);
    };
    const pickerOpen = () => $('#quick-password-picker').matches(':popover-open');
    ${code}
  })()`);
  const source = await run("return $('.tab.active').dataset.connection;");
  const previousEncoding = await run("return $('#terminal-encoding').value;");
  const stream = [...fixture.streams][0];
  const showMessageBox = dialog.showMessageBox;
  let other, entries = [], temporarySession, completed = false;
  try {
    console.log("Checking named password management and encrypted persistence");
    await run(`$('#settings-open').click(); await wait(() => $('#settings-dialog').open); $('#settings-tab-passwords').click();
      $('#vault-add').click(); $('#quick-password-description').value = '虚拟机1'; $('#quick-password-secret').value = 'qa-password';
      $('#quick-password-form').requestSubmit(); await wait(() => !$('#quick-password-editor').open && $('.vault-row'));
      $('#vault-add').click(); $('#quick-password-description').value = '备用终端密码'; $('#quick-password-secret').value = 'vault-中文-42';
      $('#quick-password-form').requestSubmit(); await wait(() => !$('#quick-password-editor').open && document.querySelectorAll('.vault-row').length === 2);
      const row = [...document.querySelectorAll('.vault-row')].find(row => row.textContent.includes('虚拟机1'));
      if (row.querySelector('input').value || !row.querySelector('.vault-remove svg')) throw new Error('Vault did not start masked with a delete icon');
      row.querySelector('.vault-reveal').click(); await wait(() => row.querySelector('input').type === 'text');
      if (row.querySelector('input').value !== 'qa-password') throw new Error('Password reveal failed');
      row.querySelector('.vault-reveal').click();
      if (row.querySelector('input').value || row.querySelector('input').type !== 'password') throw new Error('Hiding retained plaintext in the DOM');
      row.querySelector('.vault-reveal').click(); await wait(() => row.querySelector('input').type === 'text');
      $('#settings-tab-passwords').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await wait(() => $('#settings-passwords').hidden && row.querySelector('input').type === 'password' && !row.querySelector('input').value);
      $('#settings-tab-passwords').click();
      row.querySelector('.vault-edit').click();
      if ($('#quick-password-secret').value) throw new Error('Editing exposed the saved password');
      $('#quick-password-description').value = '虚拟机1（开发）'; $('#quick-password-form').requestSubmit();
      await wait(() => !$('#quick-password-editor').open && $('#vault-list').textContent.includes('虚拟机1（开发）'));`);
    entries = (await run("return await api.quickPasswords();")).items;
    const primary = entries.find(item => item.description === "虚拟机1（开发）");
    const secondary = entries.find(item => item.description === "备用终端密码");
    assert.ok(primary && secondary);
    for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ["description", "id"]);
    const persisted = fs.readFileSync(".codex-cache/qa/profile/quick-passwords.json", "utf8");
    assert.ok(!persisted.includes("qa-password") && !persisted.includes("vault-中文-42"));
    fs.writeFileSync(path.resolve(".codex-cache/qa/quick-password-settings.png"), (await win.webContents.capturePage()).toPNG());

    const otherId = await run("return await api.newWindow();");
    other = BrowserWindow.getAllWindows().find(item => item.webContents.id === otherId);
    await other.frontendReady;
    const otherRun = code => other.webContents.executeJavaScript(code);
    assert.equal((await otherRun("api.quickPasswords()")).items.length, 2);
    await otherRun(`(async () => {
      document.querySelector('#settings-open').click();
      for (let i = 0; i < 150 && !document.querySelector('#settings-dialog').open; i++) await new Promise(resolve => setTimeout(resolve, 40));
      document.querySelector('#settings-tab-passwords').click();
    })()`);
    await run(`await api.saveQuickPassword({ id: ${JSON.stringify(secondary.id)}, description: '备用终端密码（共享）', password: '' });`);
    await waitFor(() => otherRun("document.querySelector('#vault-list').textContent.includes('备用终端密码（共享）')"));
    const inputsBeforeDeniedFill = fixture.inputs.length;
    assert.match(await otherRun(`api.fillQuickPassword({ id: ${JSON.stringify(source)}, passwordId: ${JSON.stringify(primary.id)} }).then(() => '', error => error.message)`), /属于其他窗口/);
    assert.equal(fixture.inputs.length, inputsBeforeDeniedFill);
    await run("$('#settings-cancel').click(); await wait(() => !document.querySelector('.vault-secret'));");
    other.close(); other = null;
    win.focus();
    console.log("Checking password-field suggestions and explicit SSH login");
    await run(`$('#new').click(); const field = $('#session-form').elements.password; field.focus();
      await wait(pickerOpen);
      if ($('#quick-password-options').textContent.includes('qa-password')) throw new Error('Picker disclosed a password');
      [...document.querySelectorAll('.quick-password-option')].find(button => button.textContent.includes('虚拟机1（开发）')).click();
      await wait(() => field.value === 'qa-password' && !pickerOpen());
      if (field.type !== 'password' || document.querySelectorAll('.tab').length !== 1) throw new Error('Password selection submitted the form');
      $('#editor-cancel').click(); await wait(() => !$('#editor').open && !field.value);`);
    temporarySession = await run(`$('#new').click(); const form = $('#session-form');
      form.elements.name.value = '快捷密码连接验收'; form.elements.host.value = '127.0.0.1';
      form.elements.port.value = ${fixture.server.address().port}; form.elements.username.value = 'jay';
      form.elements.remember.checked = false; form.requestSubmit(); await wait(() => !$('#editor').open);
      return (await api.sessions()).find(session => session.name === '快捷密码连接验收');`);
    await run(`await wait(() => [...document.querySelectorAll('.session')].some(row => row.textContent.includes('快捷密码连接验收')));
      [...document.querySelectorAll('.session')].find(row => row.textContent.includes('快捷密码连接验收')).querySelector('button').click();
      await wait(() => $('#password-dialog').open && pickerOpen());
      [...document.querySelectorAll('.quick-password-option')].find(button => button.textContent.includes('虚拟机1（开发）')).click();
      await wait(() => $('#connect-password').value === 'qa-password' && !pickerOpen());
      if (document.querySelectorAll('.tab').length !== 1) throw new Error('Picking a password connected automatically');
      $('#password-form').requestSubmit();
      await wait(() => document.querySelectorAll('.tab').length === 2 && $('#status').textContent.includes('已连接'));
      $('.tab.active .close').click(); await wait(() => document.querySelectorAll('.tab').length === 1);`);
    await run(`await api.remove(${JSON.stringify(temporarySession.id)});`);
    temporarySession = null;

    console.log("Checking cursor-anchored prompts, keyboard selection/submission, GBK and stale picker protection");
    await run("$('.terminal-pane.active .xterm-helper-textarea').focus();");
    const inputStart = fixture.inputs.length;
    stream.write("\x1b[2J\x1b[3J\x1b[H[sudo] pass");
    await pause(100);
    assert.equal(await run("return pickerOpen();"), false);
    stream.write("word for jay: ");
    await run(`await wait(pickerOpen, 'fragmented Shell prompt');
      await wait(() => $('.terminal-pane.active .xterm-cursor'));
      const cursor = $('.terminal-pane.active .xterm-cursor').getBoundingClientRect();
      const bounds = $('#quick-password-picker').getBoundingClientRect();
      if ($('#quick-password-picker').dataset.anchor !== 'cursor' || bounds.left < cursor.right + 3 ||
          bounds.left > cursor.right + 12 || Math.abs(bounds.top - cursor.top) > 5) throw new Error('Password candidates must open beside the terminal cursor');
      if (document.activeElement !== $('.terminal-pane.active .xterm-helper-textarea')) throw new Error('Automatic candidates stole terminal focus');
      window.__qaPasswordLeft = bounds.left;`);
    assert.equal(fixture.inputs.length, inputStart, "A prompt must never send a password automatically");
    stream.write("  ");
    await run("await wait(() => $('#quick-password-picker').getBoundingClientRect().left > window.__qaPasswordLeft + 1); delete window.__qaPasswordLeft;");
    press("Up");
    await run(`await wait(() => document.querySelector('.quick-password-option[aria-selected="true"]').dataset.passwordId === ${JSON.stringify(primary.id)});`);
    press("Down");
    await run(`await wait(() => document.querySelector('.quick-password-option[aria-selected="true"]').dataset.passwordId === ${JSON.stringify(secondary.id)});`);
    press("Down");
    await run(`await wait(() => document.querySelector('.quick-password-option[aria-selected="true"]').dataset.passwordId === ${JSON.stringify(primary.id)});`);
    assert.equal(fixture.inputs.length, inputStart, "Candidate navigation must not send arrow sequences to SSH");
    fs.writeFileSync(path.resolve(".codex-cache/qa/quick-password-prompt.png"), (await win.webContents.capturePage()).toPNG());
    press("Return");
    await run("await wait(() => !pickerOpen());");
    await waitFor(() => fixture.inputs.length > inputStart);
    assert.deepEqual(Buffer.concat(fixture.inputs.slice(inputStart)), Buffer.from("qa-password\r"), "Enter must fill and submit exactly once");

    const dimensions = await run("return { rows: Number($('.terminal-pane.active').dataset.rows), cols: Number($('.terminal-pane.active').dataset.cols) };");
    stream.write(`\x1b[${dimensions.rows};${dimensions.cols - 10}H\x1b[2KPassword: `);
    await run(`await wait(pickerOpen, 'prompt near window edges');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const bounds = $('#quick-password-picker').getBoundingClientRect();
      const cursor = $('.terminal-pane.active .xterm-cursor').getBoundingClientRect();
      if (bounds.left < 7 || bounds.top < 7 || bounds.right > innerWidth - 7 || bounds.bottom > innerHeight - 7) throw new Error('Cursor candidates were clipped by the window edge');
      if (cursor.right + bounds.width + 6 > innerWidth - 8 && bounds.right > cursor.left) throw new Error('Cursor candidates did not flip left at the right edge');`);
    press("Escape");
    await run("await wait(() => !pickerOpen());");
    stream.write(" ");
    await pause(150);
    assert.equal(await run("return pickerOpen();"), false, "A dismissed prompt must remain dismissed");
    stream.write("\r\nuser@server:~$ ");
    await run(`$('#terminal-encoding').value = 'gbk'; $('#terminal-encoding').dispatchEvent(new Event('change'));
      await wait(() => !$('#terminal-encoding').disabled); $('#terminal-passwords').click(); await wait(pickerOpen, 'manual password book');
      $('#quick-password-filter').value = '备用'; $('#quick-password-filter').dispatchEvent(new Event('input'));
      if (document.querySelectorAll('.quick-password-option').length !== 1) throw new Error('Description filtering failed');`);
    const gbkStart = fixture.inputs.length;
    await run("$('.quick-password-option').click(); await wait(() => !pickerOpen());");
    await waitFor(() => fixture.inputs.length > gbkStart);
    assert.deepEqual(Buffer.concat(fixture.inputs.slice(gbkStart)), encode("vault-中文-42\r", "gbk"));
    await run(`$('#terminal-encoding').value = ${JSON.stringify(previousEncoding)}; $('#terminal-encoding').dispatchEvent(new Event('change')); await wait(() => !$('#terminal-encoding').disabled);`);

    stream.write("\r\nPassword: ");
    await run("await wait(pickerOpen, 'prompt for manual typing');");
    const manualStart = fixture.inputs.length;
    await win.webContents.insertText("manual-password");
    await run("await wait(() => !pickerOpen());");
    press("Return");
    await waitFor(() => Buffer.concat(fixture.inputs.slice(manualStart)).length >= 16);
    assert.deepEqual(Buffer.concat(fixture.inputs.slice(manualStart)), Buffer.from("manual-password\r"), "Manual input must dismiss candidates and retain normal Enter behavior");

    stream.write("\r\nPassword: ");
    await run(`await wait(pickerOpen, 'prompt before switching tabs'); window.__qaOldPasswordOption = $('.quick-password-option');
      [...document.querySelectorAll('.session')].find(row => row.textContent.includes('本地验收服务器')).querySelector('button').click();
      await wait(() => document.querySelectorAll('.tab').length === 2 && $('#status').textContent.includes('已连接') && !pickerOpen());
      $('#terminal-passwords').click(); await wait(pickerOpen);`);
    const staleStart = fixture.inputs.length;
    await run("window.__qaOldPasswordOption.click(); delete window.__qaOldPasswordOption;");
    await pause(120);
    assert.equal(fixture.inputs.length, staleStart, "A stale option must not fill a different terminal");
    await run("$('#quick-password-picker-close').click(); $('.tab.active .close').click(); await wait(() => document.querySelectorAll('.tab').length === 1);");

    // A full scrollback reuses the same absolute cursor row for later prompts.
    stream.write("\r\n" + "history\r\n".repeat(3100) + "Password: ");
    await run("await wait(pickerOpen, 'prompt with full scrollback');");
    press("Escape");
    await run("await wait(() => !pickerOpen());");
    stream.write("\r\nPassword: ");
    await run("await wait(pickerOpen, 'next password prompt after scrollback trimming'); $('#quick-password-picker-close').click();");

    dialog.showMessageBox = async () => ({ response: 0 });
    await run("$('#settings-open').click(); await wait(() => $('#settings-dialog').open); $('#settings-tab-passwords').click(); await wait(() => document.querySelectorAll('.vault-row').length === 2); $('.vault-remove').click();");
    await pause(100);
    assert.equal((await run("return await api.quickPasswords();")).items.length, 2, "Cancelling deletion must keep the password");
    dialog.showMessageBox = async () => ({ response: 1 });
    await run("$('.vault-remove').click(); await wait(() => document.querySelectorAll('.vault-row').length === 1); $('.vault-remove').click(); await wait(() => !document.querySelector('.vault-row')); $('#settings-cancel').click();");
    entries = [];
    assert.deepEqual((await run("return await api.quickPasswords();")).items, []);
    completed = true;
    console.log("PASS: encrypted passwords, reveal/hide/edit, field suggestions, cursor placement and window edges, Up/Down selection, Enter/click submission, no send before selection, GBK, stale-tab and cross-window protection, cancel/delete");
  } finally {
    if (!completed) fs.writeFileSync(path.resolve(".codex-cache/qa/quick-password-failure.png"), (await win.webContents.capturePage()).toPNG());
    dialog.showMessageBox = async () => ({ response: 1 });
    other?.destroy();
    await run(`if ($('#quick-password-editor').open) $('#quick-password-editor').close();
      if ($('#settings-dialog').open) $('#settings-cancel').click();
      if ($('#editor').open) $('#editor-cancel').click();
      if ($('#password-dialog').open) $('#password-cancel').click();
      if (pickerOpen()) $('#quick-password-picker-close').click();
      for (const tab of document.querySelectorAll('.tab')) if (tab.dataset.connection !== ${JSON.stringify(source)}) tab.querySelector('.close').click();
      $('#terminal-encoding').value = ${JSON.stringify(previousEncoding)}; $('#terminal-encoding').dispatchEvent(new Event('change')); await wait(() => !$('#terminal-encoding').disabled);`);
    if (temporarySession) await run(`await api.remove(${JSON.stringify(temporarySession.id)});`);
    for (const entry of entries) await run(`await api.removeQuickPassword(${JSON.stringify(entry.id)}).catch(() => {});`);
    dialog.showMessageBox = showMessageBox;
    stream.write("\r\n");
  }
}
module.exports = { check };
