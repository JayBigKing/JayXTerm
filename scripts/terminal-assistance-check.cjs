const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function check(win, fixture) {
  const run = code => win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const wait = async check => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('Terminal assistance timed out: ' + check + ' / search=' + $('#terminal-search-count').textContent + ' / ' + $('#toast').textContent);
    };
    ${code}
  })()`);
  const stream = [...fixture.streams][0];
  const original = await run("return await api.settings();");
  const source = await run("return $('.tab.active').dataset.connection;");
  const samples = { "sample.txt": "text", "main.cpp": "code", "deploy.sh": "shell", ".env": "config",
    "photo.png": "image", "build.tar.gz": "archive", "manual.pdf": "pdf", "data.sqlite": "database" };
  try {
    console.log("Checking visible keyword colors and compact file icons");
    for (const name of Object.keys(samples)) fixture.files.set("/home/jay/" + name, Buffer.from("UI fixture only"));
    await run(`$('#remote-path').value = '/home/jay'; $('#path-form').requestSubmit();
      await wait(() => [...document.querySelectorAll('#file-list .filename')].some(node => node.textContent === 'sample.txt'));`);
    const icons = await run(`return Object.fromEntries([...document.querySelectorAll('#file-list .file-row')].map(row => [row.querySelector('.filename').textContent, {
      kind: row.querySelector('.file-icon').dataset.fileKind, height: row.getBoundingClientRect().height,
      svg: !!row.querySelector('.file-icon svg'), deleteIcon: !!row.querySelector('.delete-one svg'),
      deleteLabel: row.querySelector('.delete-one').getAttribute('aria-label')
    }]));`);
    for (const [name, kind] of Object.entries(samples)) {
      assert.equal(icons[name].kind, kind, name);
      assert.ok(icons[name].svg && icons[name].deleteIcon, name);
      assert.ok(icons[name].height <= 30, "File rows must stay compact");
      assert.equal(icons[name].deleteLabel, "删除 " + name);
    }
    assert.equal(icons.projects.kind, "folder");
    stream.write("\x1b[2J\x1b[Hjay@dev-server:~$ ./health-check\r\n中文 🙂 Success Fail Warning Info\r\n");
    await run(`await wait(() => $('.terminal-pane.active .xterm-rows').textContent.includes('Success'));
      await wait(() => ['success', 'danger', 'warning', 'info'].every(kind =>
      document.querySelector('.terminal-pane.active .terminal-keyword[data-keyword-kind="' + kind + '"]')));`);
    fs.writeFileSync(path.resolve(".codex-cache/qa/keyword-sample.png"), (await win.webContents.capturePage()).toPNG());
    const colors = await run(`return ['Success', 'Fail', 'Warning', 'Info'].map(word => {
      const row = [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].find(node => node.textContent.includes(word));
      const start = row?.textContent.indexOf(word);
      let offset = 0;
      for (const span of row?.children || []) {
        offset += span.textContent.length;
        if (offset > start) return { word, color: getComputedStyle(span).color };
      }
      return { word, color: null };
    });`);
    const theme = require("../src/theme.mjs").createTheme(original.backgroundColor);
    const rgb = hex => "rgb(" + hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(", ") + ")";
    assert.deepEqual(colors.map(item => item.color), [theme.variables.success, theme.variables.danger, theme.variables.warning, theme.accent].map(rgb));

    console.log("Checking scrollback search, Chinese soft wraps, navigation and per-tab scope");
    const columns = await run("return Number($('.terminal-pane.active').dataset.cols);");
    stream.write("needle-中文 first\r\nneedle-中文 second\r\nNEEDLE-中文 third\r\n");
    stream.write(" ".repeat(columns - 4) + "跨行匹配needle-中文\r\n");
    stream.write(Array.from({ length: 70 }, (_, i) => `history row ${i}\r\n`).join(""));
    await run(`await wait(() => $('.terminal-pane.active .xterm-rows').textContent.includes('history row 69'));
      const searchBounds = $('#terminal-search-toggle').getBoundingClientRect();
      if (searchBounds.right > $('#terminal-encoding').getBoundingClientRect().left) throw new Error('Search must be left of encoding');
      $('#terminal-search-toggle').click();
      $('#terminal-search-input').value = 'needle-中文'; $('#terminal-search-input').dispatchEvent(new Event('input'));
      await wait(() => $('#terminal-search-count').textContent.endsWith(' / 4'));
      await wait(() => $('.terminal-pane.active .xterm-rows').textContent.toLowerCase().includes('needle-中文'));
      window.__qaSearchCount = $('#terminal-search-count').textContent;
      $('#terminal-search-next').click();
      await wait(() => $('#terminal-search-count').textContent !== window.__qaSearchCount);
      $('#terminal-search-previous').click();
      await wait(() => $('#terminal-search-count').textContent === window.__qaSearchCount);
      $('#terminal-search-case').click(); await wait(() => $('#terminal-search-count').textContent.endsWith(' / 3'));
      $('#terminal-search-case').click(); await wait(() => $('#terminal-search-count').textContent.endsWith(' / 4'));
      $('#terminal-search-input').value = '跨行匹配needle-中文'; $('#terminal-search-input').dispatchEvent(new Event('input'));
      await wait(() => $('#terminal-search-count').textContent === '1 / 1');
      [...document.querySelectorAll('.session')].find(row => row.textContent.includes('本地验收服务器')).querySelector('button').click();
      await wait(() => document.querySelectorAll('.tab').length === 2 && $('#status').textContent.includes('已连接'));
      await wait(() => $('#terminal-search-count').textContent === '0 / 0');
      $('.tab.active .close').click();
      await wait(() => document.querySelectorAll('.tab').length === 1 && $('#terminal-search-count').textContent === '1 / 1');
      $('#terminal-search-input').value = 'Success'; $('#terminal-search-input').dispatchEvent(new Event('input'));
      await wait(() => $('#terminal-search-count').textContent === '1 / 1');`);
    fs.writeFileSync(path.resolve(".codex-cache/qa/terminal-search-icons.png"), (await win.webContents.capturePage()).toPNG());
    await run(`$('#terminal-search-close').click(); await wait(() => $('#terminal-search').hidden);
      $('#settings-open').click(); await wait(() => $('#settings-dialog').open);
      $('#settings-tab-terminal').click();
      $('#settings-highlight-keywords').checked = false; $('#settings-highlight-keywords').dispatchEvent(new Event('input'));
      await wait(() => !document.querySelector('.terminal-keyword'));
      $('#settings-cancel').click(); await wait(() => !$('#settings-dialog').open);
      await wait(() => document.querySelector('.terminal-keyword'));
    `);
    // Full-screen programs keep their own colors and normal-buffer highlights return afterwards.
    stream.write("\x1b[?1049h\x1b[2J\x1b[HSuccess Fail Warning");
    await run(`await wait(() => $('.terminal-pane.active .xterm-rows').textContent.includes('Success Fail Warning'));
      await wait(() => !document.querySelector('.terminal-keyword'));`);
    stream.write("\x1b[?1049l");
    await run(`await wait(() => document.querySelector('.terminal-keyword'));
      $('#terminal-search-toggle').click(); $('#terminal-search-input').value = 'no-such-ui-search-value';
      $('#terminal-search-input').dispatchEvent(new Event('input'));
      await wait(() => $('#terminal-search-count').textContent === '0 / 0');
      if (!$('#terminal-search-next').disabled || !$('#terminal-search-previous').disabled) throw new Error('Empty search navigation remained enabled');
      $('#terminal-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (!$('#terminal-search').hidden) throw new Error('Escape did not close search');
      $('#file-workspace-toggle').click(); $('#terminal-search-toggle').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.activeElement !== $('#terminal-search-input') || $('#file-workspace-toggle').getAttribute('aria-pressed') !== 'false') throw new Error('Opening search from file space lost keyboard focus');
      $('#terminal-search-close').click();`);
    console.log("PASS: keyword colors, Unicode cells, alternate-screen exclusion, scrollback/wrapped search, navigation, tab scope, compact SVG file and delete icons");
  } finally {
    await run(`if ($('#settings-dialog').open) $('#settings-cancel').click();
      if (!$('#terminal-search').hidden) $('#terminal-search-close').click();
      for (const tab of document.querySelectorAll('.tab')) if (tab.dataset.connection !== ${JSON.stringify(source)}) tab.querySelector('.close').click();
      await api.applySettings(${JSON.stringify({ ...original, cachePath: original.pendingCache ?? original.cachePath })});`);
    stream.write("\x1b[?1049l\r\n");
    for (const name of Object.keys(samples)) fixture.files.delete("/home/jay/" + name);
    await run("$('#remote-path').value = '/home/jay'; $('#path-form').requestSubmit();");
  }
}
module.exports = { check };
