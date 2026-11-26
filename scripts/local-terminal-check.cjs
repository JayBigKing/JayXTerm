const assert = require("node:assert/strict");

async function check(win, fixture) {
  const run = code => win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const localTabs = () => [...document.querySelectorAll('.tab')].filter(tab => tab.textContent.startsWith('本地 · '));
    const wait = async condition => {
      const deadline = Date.now() + 10000;
      while (!condition()) {
        if (Date.now() > deadline) {
          const rows = [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')];
          const output = rows.map(row => row.textContent.trim()).filter(Boolean).slice(-8).join(' | ');
          throw Error('Local terminal timed out: ' + condition + ' / ' + $('#status').textContent + ' / Recent output: ' + output);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    ${code}
  })()`);
  const before = await run("return await api.localTerminal.profiles();");
  const beforeShortcuts = await run("return (await api.settings()).shortcuts;");
  const remote = await run("return $('.tab.active').dataset.connection;");
  const expectedDefault = process.platform === "win32"
    ? before.available.some(profile => profile.id === "git-bash") ? "git-bash" : "cmd"
    : before.available[0]?.id;
  assert.equal(before.selected, expectedDefault);
  const primary = before.available.find(profile => profile.id === before.selected);
  const alternative = before.available.find(profile => profile.id !== before.selected && !profile.id.startsWith("wsl:"));
  assert.ok(alternative);
  const label = profile => `本地 · ${profile.name}`;
  const choice = (list, id) => `[...$('${list}').children].find(button => button.dataset.shell === ${JSON.stringify(id)})`;
  const openWorkbench = "$('#window-tools-menu').click();";
  const showMenu = async profile => run(`${openWorkbench} $('#local-terminal-menu').click();
    await wait(() => !$('#local-terminal-defaults').disabled && ${choice("#local-terminal-profiles", profile.id)});`);
  const waitForShell = async profile => run(`await wait(() => $('#status').textContent === ${JSON.stringify(label(profile) + " · 运行中")});`);
  const keystroke = (keyCode, modifiers) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  const enter = async command => {
    await run("$('.terminal-pane.active .xterm-helper-textarea').focus();");
    for (const char of command) win.webContents.sendInputEvent({ type: "char", keyCode: char });
    keystroke("Return");
  };
  const seeLine = line => run(`await wait(() => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')]
    .some(row => row.textContent.trim() === ${JSON.stringify(line)}));`);
  const zoom = win.webContents.getZoomFactor();
  const localShortcut = '[data-shortcut="openLocalTerminal"]';
  const openShortcuts = async () => run(`$('#settings-open').click();
    await wait(() => $('#settings-dialog').open);
    $('#settings-tab-shortcuts').click();`);
  const saveSettings = async () => run(`$('#settings-form').requestSubmit(); await wait(() => !$('#settings-dialog').open);`);

  try {
    await run(`${openWorkbench}
      if (!$('#local-terminal-open').closest('#window-tools-options') ||
          !$('#local-terminal-menu').closest('#window-tools-options')) throw Error('Local terminal controls must be inside Workbench');
      $('#local-terminal-open').click();`);
    await waitForShell(primary);
    assert.equal(await run("return $('#mode-files').disabled && $('#terminal-encoding').disabled && $('#move-tab').disabled;"), true);
    const remoteInputCount = fixture.inputs.length;
    const cmd = primary.id === "cmd";
    await enter(cmd ? "echo JAYXTERM_%OS%_LOCAL" : "printf '%s%s\\n' JAYXTERM_ LOCAL");
    await seeLine(cmd ? "JAYXTERM_Windows_NT_LOCAL" : "JAYXTERM_LOCAL");
    if (process.platform === "darwin") {
      const originalCols = await run("return $('.terminal-pane.active').dataset.cols;");
      win.webContents.setZoomFactor(1.25);
      const dimensions = await run(`const pane = $('.terminal-pane.active');
        await wait(() => pane.dataset.cols !== ${JSON.stringify(originalCols)});
        return pane.dataset.rows + ' ' + pane.dataset.cols;`);
      await enter("stty size");
      await seeLine(dimensions);
      win.webContents.setZoomFactor(zoom);
    }
    // Let the foreground process acknowledge readiness after installing its
    // handler. Keep follow-up input out of the PTY until the Shell resumes.
    const interruptProbe = "const timer = setTimeout(() => { process.exitCode = 1; }, 25000); " +
      "process.once('SIGINT', () => { clearTimeout(timer); process.stdout.write('\\nJAYXTERM_' + 'INTERRUPTED\\n'); }); " +
      "console.log('JAYXTERM_' + 'INTERRUPT_READY');";
    const resumed = cmd ? "echo JAYXTERM_%OS%_RESUMED" : "printf '%s%s\\n' JAYXTERM_ RESUMED";
    await enter(`node -e "${interruptProbe}" && ${resumed}`);
    await seeLine("JAYXTERM_INTERRUPT_READY");
    keystroke("C", ["control"]);
    await seeLine("JAYXTERM_INTERRUPTED");
    await seeLine(cmd ? "JAYXTERM_Windows_NT_RESUMED" : "JAYXTERM_RESUMED");
    assert.equal(fixture.inputs.length, remoteInputCount, "Local input must stay out of SSH");
    await enter("exit");
    await run("await wait(() => $('#status').textContent.endsWith('已退出'));");

    await showMenu(alternative);
    await run(`${choice("#local-terminal-profiles", alternative.id)}.click();`);
    await waitForShell(alternative);
    assert.equal((await run("return await api.localTerminal.profiles();")).selected, primary.id);

    await showMenu(alternative);
    await run("$('#local-terminal-defaults').click(); await wait(() => !$('#workbench-shell-defaults').hidden);");
    keystroke("Escape");
    await run("await wait(() => !$('#workbench-shells').hidden && $('#window-tools-options').matches(':popover-open')); ");
    await run(`$('#local-terminal-defaults').click();
      ${choice("#local-terminal-default-choices", alternative.id)}.click();
      await wait(() => !$('#workbench-shells').hidden && $('#local-terminal-default-label').textContent === ${JSON.stringify(alternative.name)});`);
    assert.equal((await run("return await api.localTerminal.profiles();")).preferred, alternative.id);
    await run("$('#window-tools-options').hidePopover(); $('.terminal-pane.active .xterm-helper-textarea').focus();");
    keystroke("T", ["control", "shift"]);
    await run("await wait(() => localTabs().length === 3);");
    await waitForShell(alternative);

    await showMenu(primary);
    await run(`$('#local-terminal-defaults').click(); ${choice("#local-terminal-default-choices", "")}.click();
      await wait(() => !$('#workbench-shells').hidden && $('#local-terminal-default-label').textContent === '自动');
      $('#local-terminal-back').click();
      await wait(() => !$('#workbench-main').hidden);
      if (localTabs().length !== 3) throw Error('Changing the default must not open a terminal');`);
    assert.equal((await run("return await api.localTerminal.profiles();")).selected, primary.id);
    console.log("PASS: compact Workbench, real PTY input and Ctrl+C, Shell choice, shortcut, and automatic default reset");

    await run("$('#window-tools-options').hidePopover();");
    await openShortcuts();
    await run(`const row = $('${localShortcut}'); row.querySelector('.settings-shortcut-clear').click();
      if (row.querySelector('.settings-shortcut-record').textContent !== '未设置') throw Error('Cleared binding is not shown');`);
    await saveSettings();
    await run(`await wait(() => !$('#local-terminal-open').hasAttribute('aria-keyshortcuts'));
      const unbound = new KeyboardEvent('keydown', { code: 'KeyT', key: 'T', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(unbound);
      if (unbound.defaultPrevented || localTabs().length !== 3) throw Error('Cleared shortcut was still intercepted');`);
    assert.equal((await run("return (await api.settings()).shortcuts;")).openLocalTerminal, "");

    await openShortcuts();
    await run(`$('${localShortcut} .settings-shortcut-record').click();`);
    keystroke("N", ["control", "shift"]);
    await run("await wait(() => $('#settings-shortcut-status').textContent.includes('新窗口'));");
    keystroke("Y", ["control", "shift"]);
    await run(`await wait(() => $('${localShortcut} .settings-shortcut-record').textContent === 'Ctrl+Shift+Y');`);
    await saveSettings();
    await run(`await wait(() => $('#local-terminal-open').getAttribute('aria-keyshortcuts') === 'Control+Shift+Y');
      $('.terminal-pane.active .xterm-helper-textarea').focus();`);
    keystroke("Y", ["control", "shift"]);
    await run("await wait(() => localTabs().length === 4);");
    await waitForShell(primary);

    await openShortcuts();
    await run(`$('#settings-default-shortcuts').click(); $('#settings-cancel').click();
      await wait(() => !$('#settings-dialog').open);`);
    assert.equal((await run("return (await api.settings()).shortcuts;")).openLocalTerminal, "Ctrl+Shift+KeyY");
    console.log("PASS: cleared shortcut stays empty, conflicts are reported, custom binding works, and cancel keeps saved settings");
  } finally {
    win.webContents.setZoomFactor(zoom);
    await run(`if ($('#settings-dialog').open) $('#settings-cancel').click();
      const saved = await api.settings();
      await api.applySettings({ ...saved, cachePath: saved.pendingCache ?? saved.cachePath, shortcuts: ${JSON.stringify(beforeShortcuts)} });
      await api.localTerminal.setDefault(${JSON.stringify(before.preferred)});
      $('#window-tools-options').hidePopover();
      for (const tab of localTabs()) tab.querySelector('.close').click();
      document.querySelector('.tab[data-connection="${remote}"]').click();`);
  }
}

module.exports = { check };
