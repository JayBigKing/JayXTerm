const assert = require("node:assert/strict");
const { BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const iconv = require("iconv-lite");
const { createFixture } = require("./ssh-fixture.cjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let i = 0; i < 150; i++) {
    const result = await check();
    if (result) return result;
    await pause(40);
  }
  throw new Error(message);
}

async function check(sourceWindow, worker) {
  const fixture = createFixture();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  let win;
  try {
    const windowId = await sourceWindow.webContents.executeJavaScript("api.newWindow()");
    win = BrowserWindow.getAllWindows().find((item) => item.webContents.id === windowId);
    await win.frontendReady;
    const run = (source) => win.webContents.executeJavaScript(`(async () => {
      const $ = (selector) => document.querySelector(selector);
      const $$ = (selector) => [...document.querySelectorAll(selector)];
      const wait = async (check) => {
        for (let i = 0; i < 150; i++) {
          if (await check()) return;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Reconnect UI timed out: ' + check + ' / ' + $('#toast').textContent);
      };
      ${source}
    })()`);
    const saveSession = (name, remember) => run(`
      $('#new').click();
      const form = $('#session-form');
      form.elements.name.value = ${JSON.stringify(name)};
      form.elements.host.value = '127.0.0.1';
      form.elements.port.value = '${fixture.server.address().port}';
      form.elements.username.value = 'jay';
      form.elements.password.value = 'qa-password';
      form.elements.remember.checked = ${remember};
      form.requestSubmit();
      await wait(() => !$('#editor').open);
    `);
    const openSession = (name) => run(`
      $('#mode-sessions').click();
      $$('.session').find(row => row.querySelector('strong').textContent === ${JSON.stringify(name)})
        .querySelector('button').click();
    `);
    const tabSelector = (id) => `.tab[data-connection="${id}"]`;
    const currentId = () => run("return $('.terminal-group.focused .tab.active')?.dataset.connection;");
    const waitReady = () => run(`await wait(() => $('#status').textContent.includes('已连接') &&
      $('#file-list').textContent.includes('README.md'));`);
    const disconnect = async (id, stream) => {
      stream.end();
      await run(`await wait(() => $('${tabSelector(id)}')?.classList.contains('disconnected') &&
        !$('${tabSelector(id)} .tab-reconnect').hidden);`);
    };
    const reconnect = async (id, action, expectedTabs) => {
      const before = fixture.authenticated;
      const streams = new Set(fixture.streams);
      await run(`
        const tab = $('${tabSelector(id)}');
        ${action}
        await wait(() => !$('${tabSelector(id)}'));
        await wait(() => $$('.tab').length === ${expectedTabs} &&
          $$('.tab').every(tab => tab.title.includes('已连接')));
      `);
      await waitFor(() => fixture.streams.size === expectedTabs, "Reconnect leaked a shell");
      assert.equal(fixture.authenticated, before + 1, "Repeated gestures must create only one connection");
      return [...fixture.streams].find((stream) => !streams.has(stream));
    };

    await saveSession("断线重连验收", true);
    const ids = [], streams = [];
    for (let index = 0; index < 4; index++) {
      if (index === 3) await run(`$('#split-add').click();
        $('.terminal-group:last-child .group-empty').click();`);
      const before = new Set(fixture.streams);
      await openSession("断线重连验收");
      await waitReady();
      ids.push(await currentId());
      streams.push([...fixture.streams].find((stream) => !before.has(stream)));
    }
    const beforeConnectedClicks = fixture.authenticated;
    await run(`
      if ($$('.tab-reconnect').some(button => !button.hidden))
        throw new Error('Connected tabs must hide reconnect');
      $('.terminal-group.focused .tab-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      $('.terminal-group.focused .terminal-pane.active .xterm-screen')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    `);
    await pause(120);
    assert.equal(fixture.authenticated, beforeConnectedClicks, "Connected double-clicks must not reconnect");

    // Reconnect the middle tab in an unfocused split, retaining both neighbors.
    await run(`
      $('${tabSelector(ids[1])} .tab-select').click();
      $('#terminal-encoding').value = 'gbk';
      $('#terminal-encoding').dispatchEvent(new Event('change'));
      await wait(() => !$('#terminal-encoding').disabled);
      $('${tabSelector(ids[2])} .tab-select').click();
      $('${tabSelector(ids[3])} .tab-select').click();
    `);
    await disconnect(ids[1], streams[1]);
    fs.writeFileSync(path.resolve(".codex-cache/qa/reconnect-disconnected.png"),
      (await win.webContents.capturePage()).toPNG());
    let stream = await reconnect(ids[1], `
      const button = tab.querySelector('.tab-reconnect');
      button.click();
      if (!button.disabled) throw new Error('Reconnect did not lock immediately');
      button.click();
      tab.querySelector('.tab-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    `, 4);
    const nextIds = await run("return $$('.tab').map(tab => tab.dataset.connection);");
    assert.deepEqual([nextIds[0], nextIds[2], nextIds[3]], [ids[0], ids[2], ids[3]]);
    assert.equal(await currentId(), ids[3], "Background reconnect must preserve focus");
    assert.deepEqual(await run("return $$('.terminal-group').map(group => group.querySelectorAll('.tab').length);"), [3, 1]);
    let id = nextIds[1];
    assert.notEqual(id, ids[1]);
    await run(`$('${tabSelector(id)} .tab-select').click();`);
    await waitReady();
    assert.equal(await run("return $('#terminal-encoding').value;"), "gbk");
    stream.write(iconv.encode("\r\n重连编码正确\r\n", "gbk"));
    await run(`await wait(() => $('.terminal-group.focused .terminal-pane.active').textContent.includes('重连编码正确'));`);
    await win.webContents.insertText("重连输入");
    await waitFor(() => fixture.inputRecords.some((record) => record.stream === stream &&
      record.data.equals(iconv.encode("重连输入", "gbk"))), "Reconnected terminal input used the wrong connection or encoding");
    win.webContents.send("ssh:event", { type: "closed", id: ids[1] });
    await run(`if ($('${tabSelector(id)} .tab-reconnect').hidden !== true)
      throw new Error('Late close from old connection affected its replacement');`);

    await disconnect(id, stream);
    stream = await reconnect(id, `
      tab.querySelector('.tab-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      tab.querySelector('.tab-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    `, 4);
    id = await currentId();
    await disconnect(id, stream);
    stream = await reconnect(id, `
      $('.terminal-group.focused .terminal-pane.active .xterm-screen')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    `, 4);
    id = await currentId();
    await waitReady();
    console.log("PASS: tab refresh, tab/pane double-click, deduplication, split/order/focus preservation, GBK input/output and SFTP recovery");

    // Close immediately after posting the IPC request, before its reply arrives.
    await disconnect(id, stream);
    await run(`
      const tab = $('${tabSelector(id)}');
      tab.querySelector('.tab-reconnect').click();
      tab.querySelector('.close').click();
    `);
    await pause(250);
    assert.equal(await run("return $$('.tab').length;"), 3, "Closing during reconnect reopened the tab");
    await waitFor(() => fixture.streams.size === 3, "Closing during reconnect left a live SSH shell");

    await saveSession("重连密码验收", false);
    await openSession("重连密码验收");
    await run(`
      await wait(() => $('#password-dialog').open);
      $('#connect-password').value = 'wrong-password';
      $('#password-form').requestSubmit();
      await wait(() => $('.terminal-group.focused .tab.active')?.classList.contains('disconnected'));
    `);
    id = await currentId();
    const beforeCancel = fixture.authenticated;
    await run(`
      const tab = $('${tabSelector(id)}');
      tab.querySelector('.tab-reconnect').click();
      await wait(() => $('#password-dialog').open);
      $('#password-cancel').click();
      await wait(() => !tab.querySelector('.tab-reconnect').disabled);
      if (tab.querySelector('.tab-reconnect').hidden || !tab.isConnected)
        throw new Error('Cancelling the password prompt removed the retry');
    `);
    assert.equal(fixture.authenticated, beforeCancel);
    assert.equal(await currentId(), id);
    await run(`
      $('${tabSelector(id)} .tab-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await wait(() => $('#password-dialog').open);
      $('#connect-password').value = 'qa-password';
      $('#password-form').requestSubmit();
    `);
    await waitReady();
    assert.equal(fixture.authenticated, beforeCancel + 1);
    assert.equal(await run("return $$('.tab').length;"), 4);
    assert.ok(await run("return $('.terminal-group.focused .tab.active .tab-reconnect').hidden;"));
    console.log("PASS: failed authentication retry, password cancellation/re-entry and closing during reconnect without leaked tabs or connections");

    // Worker death is different from an individual SSH connection closing.
    // Keep it last: every terminal in this test application loses its backend.
    assert.ok(worker?.connected, "Crash regression requires the application's SSH worker");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH worker did not exit")), 5000);
      worker.once("exit", () => { clearTimeout(timer); resolve(); });
      worker.kill("SIGKILL");
    });
    await run(`await wait(() => $$('.tab').every(tab => tab.classList.contains('disconnected')));`);
    // Use a session with a saved password so all reconnect gestures send IPC immediately.
    await run(`$('.tab .tab-select').click();`);
    const authenticated = fixture.authenticated;
    await run(`
      const tab = $('.tab.active');
      const id = tab.dataset.connection;
      const pane = $('.terminal-group.focused .terminal-pane.active');
      // xterm renders queued output asynchronously after the disconnect event.
      await wait(() => pane.textContent.includes('SSH 后台进程已退出'));
      const count = $$('.tab').length;
      const retry = tab.querySelector('.tab-reconnect');
      for (const gesture of [
        () => retry.click(),
        () => tab.querySelector('.tab-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
        () => pane.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
      ]) {
        $('#toast').textContent = '';
        gesture();
        await wait(() => $('#toast').textContent.includes('请重启应用') && !retry.disabled);
        if ($('.tab.active') !== tab || tab.dataset.connection !== id || $$('.tab').length !== count)
          throw new Error('Failed reconnect replaced the original tab');
        if (!tab.classList.contains('disconnected') || retry.hidden || !pane.isConnected ||
            !pane.textContent.includes('Welcome to JayXTerm'))
          throw new Error('Failed reconnect lost terminal contents or retry state');
      }

      const expectUnavailable = async (request) => {
        let timer;
        try {
          const result = await Promise.race([
            request().then(() => 'unexpected success', error => error.message),
            new Promise(resolve => { timer = setTimeout(() => resolve('request timed out'), 1500); }),
          ]);
          if (!result.includes('请重启应用')) throw new Error(result);
        } finally { clearTimeout(timer); }
      };
      const session = (await api.sessions()).find(item => item.name === '断线重连验收');
      await expectUnavailable(() => api.connect({ sessionId: session.id, cols: 100, rows: 30 }));
      await expectUnavailable(() => api.test({ ...session, password: 'qa-password' }));
      await expectUnavailable(() => api.list({ id, path: '.' }));
      if ($$('.tab').length !== count) throw new Error('Unavailable worker created an extra tab');
    `);
    assert.equal(fixture.authenticated, authenticated, "Dead-worker requests must not start SSH connections");
    fs.writeFileSync(path.resolve(".codex-cache/qa/reconnect-worker-exit.png"),
      (await win.webContents.capturePage()).toPNG());
    console.log("PASS: worker exit rejects reconnect/new connections, connection tests and SFTP immediately while preserving tabs and terminal contents");
  } finally {
    win?.destroy();
    fixture.close();
  }
}
module.exports = { check };
