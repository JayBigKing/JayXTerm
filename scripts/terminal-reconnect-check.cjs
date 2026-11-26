const assert = require("node:assert/strict");
const { dialog, Menu } = require("electron");

async function check(win, fixture) {
  const run = code => win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const wait = async condition => {
      const deadline = Date.now() + 8000;
      while (!condition()) {
        if (Date.now() >= deadline) throw Error('Reconnect timed out: ' + condition + ' / ' + $('#status').textContent);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const checkLamp = (state) => {
      const style = getComputedStyle($('.tab.active .dot'));
      const token = style.getPropertyValue('--tab-lamp-' + state).trim();
      const color = token.slice(1).match(/../g).map(channel => parseInt(channel, 16));
      if (style.width !== '8px' || style.height !== '8px' || style.boxShadow === 'none' ||
          style.backgroundColor !== 'rgb(' + color.join(', ') + ')')
        throw Error('Unexpected status light for ' + state);
    };
    ${code}
  })()`);
  const stream = [...fixture.streams][0];
  assert.ok(stream, "The original SSH stream must be open");
  let refresh;
  const originalMenu = Menu.buildFromTemplate;
  const originalDialog = dialog.showMessageBox;
  Menu.buildFromTemplate = items => ({
    popup() { refresh = items.find(item => item.label === "刷新终端"); },
  });
  const openMenu = () => run("await api.tabMenu($('.tab.active').dataset.connection);");
  const connectionId = () => run("return $('.tab.active').dataset.connection;");
  const waitForReconnect = (oldId) => run(`
    await wait(() => $('.tab.active').dataset.connection !== ${JSON.stringify(oldId)} &&
      $('.tab.active').dataset.connectionState === 'ready');
    await wait(() => $('#file-list').textContent.includes('README.md'));`);
  const checkFreshOutput = () => run(`
    const output = $('.terminal-pane.active .xterm-rows');
    await wait(() => output.textContent.includes('jay@dev-server:~$'));
    if (!output.firstElementChild.textContent.startsWith('正在重新连接 ') ||
        output.textContent.split('Welcome to JayXTerm').length !== 2 ||
        /QA_OLD_|连接已关闭/.test(output.textContent))
      throw Error('Reconnect must start with a clean screen and a fresh login');`);
  const setSearch = (enabled) => run(`
    $('#settings-open').click();
    await wait(() => $('#settings-dialog').open);
    $('#settings-tab-terminal').click();
    $('#settings-form').elements.terminalSearchEnabled.checked = ${enabled};
    $('#settings-save').click();
    await wait(() => !$('#settings-dialog').open);`);
  const searchWasEnabled = await run("return (await api.settings()).terminalSearchEnabled;");
  try {
    await run(`window.__reconnectHeader = $('.tab.active');
      window.__reconnectPane = $('.terminal-pane.active');
      window.__reconnectId = window.__reconnectHeader.dataset.connection;
      window.__reconnectColor = getComputedStyle($('.tab.active .dot')).backgroundColor;
      if (window.__reconnectHeader.dataset.connectionState !== 'ready') throw Error('Tab did not connect');
      checkLamp('ready');`);
    await openMenu();
    assert.equal(refresh?.enabled, true, "Refresh must be available while the SSH tab is green");
    const originalId = await connectionId();
    let confirmation;
    dialog.showMessageBox = async (_win, options) => {
      confirmation = options;
      return { response: 0 };
    };
    await refresh.click();
    assert.equal(confirmation?.cancelId, 0);
    assert.equal(await connectionId(), originalId);
    dialog.showMessageBox = originalDialog;

    if (!searchWasEnabled) await setSearch(true);
    stream.write("\r\nQA_OLD_SCROLLBACK\r\n" + "past command\r\n".repeat(200) + "QA_OLD_SCREEN\r\n");
    await run(`const output = $('.terminal-pane.active .xterm-rows');
      await wait(() => output.textContent.includes('QA_OLD_SCREEN'));
      if (output.textContent.includes('QA_OLD_SCROLLBACK')) throw Error('Old marker should be in scrollback');
      $('#terminal-search-toggle').click();
      $('#terminal-search-input').value = 'QA_OLD_SCROLLBACK';
      $('#terminal-search-input').dispatchEvent(new Event('input'));
      await wait(() => $('#terminal-search-count').textContent === '1 / 1');`);
    stream.eof();
    await run(`await wait(() => $('.tab.active').dataset.connectionState === 'closed');
      checkLamp('disconnected');
      if (getComputedStyle($('.tab.active .dot')).backgroundColor === window.__reconnectColor ||
          !$('#status').textContent.includes('已断开')) throw Error('A disconnected tab still looks connected');`);
    await openMenu();
    assert.equal(refresh?.enabled, true);
    const authenticated = fixture.authenticated;
    dialog.showMessageBox = async () => { throw Error("Disconnected sessions must reconnect without confirmation"); };
    await refresh.click();
    dialog.showMessageBox = originalDialog;

    await waitForReconnect(originalId);
    await checkFreshOutput();
    await run(`
      await wait(() => $('#terminal-search-count').textContent === '0 / 0');
      $('#terminal-search-close').click();
      $('#terminal-search-input').value = '';
      if ($('.tab.active') !== window.__reconnectHeader || $('.terminal-pane.active') !== window.__reconnectPane ||
          $('.tab.active').dataset.connection === window.__reconnectId || document.querySelectorAll('.tab').length !== 1)
        throw Error('Reconnect must replace only the underlying connection');
      if (getComputedStyle($('.tab.active .dot')).backgroundColor !== window.__reconnectColor || $('#password-dialog').open)
        throw Error('Reconnect lost connected status or saved credentials');`);
    assert.equal(fixture.authenticated, authenticated + 1);
    await openMenu();
    assert.equal(refresh?.enabled, true);
    const reconnectedId = await connectionId();
    const replacement = [...fixture.streams].at(-1);
    replacement.write("\x1b[?1049h\x1b[HQA_OLD_ALT_SCREEN\x1b]0;unfinished title");
    await run("await wait(() => $('.terminal-pane.active .xterm-rows').textContent.includes('QA_OLD_ALT_SCREEN'));");
    await refresh.click();
    await waitForReconnect(reconnectedId);
    await checkFreshOutput();
    assert.equal(fixture.authenticated, authenticated + 2);
    console.log("PASS: SSH refresh keeps the tab, clears scrollback and alternate screen, and shows one fresh login");
  } finally {
    dialog.showMessageBox = originalDialog;
    Menu.buildFromTemplate = originalMenu;
    if (!searchWasEnabled) await setSearch(false);
    await run(`for (const key of ['Header', 'Pane', 'Id', 'Color']) delete window['__reconnect' + key];`);
  }
}

module.exports = { check };
