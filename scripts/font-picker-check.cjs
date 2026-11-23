const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserWindow } = require("electron");

function runner(win) {
  return code => win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const wait = async check => {
      for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Font picker timed out: ' + check + ' / ' + $('#font-picker-status').textContent);
    };
    const opened = () => $('#font-picker').matches(':popover-open');
    const loaded = () => opened() && $('#font-picker-list').getAttribute('aria-busy') === 'false';
    const openSettings = async () => {
      $('#settings-open').click(); await wait(() => $('#settings-dialog').open);
      $('#settings-tab-terminal').click();
    };
    ${code}
  })()`);
}
async function click(win, selector, text) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = ${text === undefined ? 'nodes[0]' : `nodes.find(node => node.textContent === ${JSON.stringify(text)})`};
    if (!element) throw new Error('Missing clickable font control: ' + ${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Font control is covered');
    return { x, y };
  })()`);
  for (const type of ["mouseDown", "mouseUp"])
    win.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
}
function press(win, keyCode) {
  for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode });
}
async function platformFonts(win, selector) {
  win.webContents.debugger.attach("1.3");
  try {
    const send = (method, params) => win.webContents.debugger.sendCommand(method, params);
    await send("DOM.enable"); await send("CSS.enable");
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, selector);
    return (await send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
  } finally { win.webContents.debugger.detach(); }
}

async function check(win, fixture) {
  const run = runner(win);
  const original = await run("return await api.settings();");
  const before = await run("return getComputedStyle($('.terminal-pane.active .xterm-rows')).fontFamily;");
  let other;
  try {
    // Count real font enumeration calls while retaining the actual OS results.
    await run(`window.__nativeFontQuery = window.queryLocalFonts;
      window.__fontQueryCount = 0;
      window.queryLocalFonts = async () => {
        window.__fontQueryCount++;
        return window.__fontFaces = await window.__nativeFontQuery();
      };
      await openSettings();`);
    await click(win, "#settings-font-family-picker");
    await run("await wait(loaded);");
    await click(win, "#settings-font-family-picker");
    await run("await wait(() => !opened());");
    await click(win, "#settings-font-family-picker");
    await run("await wait(loaded);");
    const names = await run("return [...new Set(window.__fontFaces.map(face => face.family))];");
    assert.ok(names.length > 5, "Must list installed fonts instead of five hardcoded suggestions");
    assert.ok(await run("return document.querySelectorAll('.font-picker-option').length <= 16;"));
    fs.writeFileSync(path.resolve(".codex-cache/qa/font-picker.png"), (await win.webContents.capturePage()).toPNG());
    const latin = names.find(name => name === "Consolas") || names.find(name => name === "Liberation Mono") || names[0];
    win.webContents.insertText(latin);
    await run(`await wait(() => [...document.querySelectorAll('.font-picker-option')].some(row => row.textContent === ${JSON.stringify(latin)}));`);
    await click(win, ".font-picker-option", latin);
    await run(`await wait(() => !opened() && $('#settings-font-family').value === ${JSON.stringify(latin)});`);

    await click(win, "#settings-cjk-font-family-picker");
    await run("await wait(loaded);");
    assert.equal(await run("return window.__fontQueryCount;"), 1, "Both selectors share a cached catalog");
    const chinese = ["Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "PingFang SC", "Noto Sans CJK SC"].find(name => names.includes(name));
    assert.ok(chinese, "Font rendering QA requires an installed Chinese font");
    win.webContents.insertText(chinese);
    await run(`await wait(() => [...document.querySelectorAll('.font-picker-option')].some(row => row.textContent === ${JSON.stringify(chinese)}));`);
    // Exercise native arrow keys and Enter selection without submitting settings.
    press(win, "Down"); press(win, "Up"); press(win, "Return");
    await run(`await wait(() => !opened());
      if ($('#settings-cjk-font-family').value !== ${JSON.stringify(chinese)}) throw new Error('Keyboard font selection failed');
      if (!$('#settings-dialog').open) throw new Error('Selecting a font submitted the settings form');
      await document.fonts.ready;
      await wait(() => getComputedStyle($('.terminal-pane.active .xterm-rows')).fontFamily.includes('JayXTerm CJK'));`);
    const previewFonts = await platformFonts(win, "#settings-font-preview");
    assert.ok(previewFonts.some(font => font.familyName === latin), JSON.stringify(previewFonts));
    assert.ok(previewFonts.some(font => font.familyName === chinese), JSON.stringify(previewFonts));
    await click(win, "#settings-cjk-font-family-picker");
    press(win, "Escape");
    await run("await wait(() => !opened()); if (!$('#settings-dialog').open) throw new Error('Escape closed settings');");
    await run("$('#settings-cancel').click(); await wait(() => !$('#settings-dialog').open);");
    await run(`await wait(() => getComputedStyle($('.terminal-pane.active .xterm-rows')).fontFamily === ${JSON.stringify(before)});`);
    assert.deepEqual(await run("return await api.settings();"), original, "Cancel must not persist a preview");

    // Save in one window and verify an already connected terminal in another.
    const otherId = await run("return await api.newWindow();");
    other = BrowserWindow.getAllWindows().find(item => item.webContents.id === otherId);
    await other.frontendReady;
    const otherRun = runner(other);
    await otherRun(`await wait(() => [...document.querySelectorAll('.session')].some(row => row.textContent.includes('本地验收服务器')));
      [...document.querySelectorAll('.session')].find(row => row.textContent.includes('本地验收服务器')).querySelector('button').click();
      await wait(() => $('#status').textContent.includes('已连接'));`);
    await run(`await openSettings();
      $('#settings-font-family').value = ${JSON.stringify(latin)};
      $('#settings-cjk-font-family').value = ${JSON.stringify(chinese)};
      $('#settings-font-size').dispatchEvent(new Event('input'));
      $('#settings-save').click(); await wait(() => !$('#settings-dialog').open);`);
    await otherRun("await wait(() => getComputedStyle($('.terminal-pane.active .xterm-rows')).fontFamily.includes('JayXTerm CJK')); await document.fonts.ready;");
    assert.equal((await otherRun("return await api.settings();")).cjkFontFamily, chinese);
    const persisted = JSON.parse(fs.readFileSync(".codex-cache/qa/profile/settings.json", "utf8"));
    assert.equal(persisted.cjkFontFamily, chinese);

    // Inspect actual terminal glyphs and ranges, rather than only CSS declarations.
    const stream = [...fixture.streams][0];
    stream.write("\x1b[2J\x1b[HFONT-QA ABC中文，。0123\r\n");
    const grid = await run(`await wait(() => $('.terminal-pane.active .xterm-rows').textContent.includes('FONT-QA ABC中文，。0123'));
      const row = [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].find(row => row.textContent.includes('FONT-QA'));
      row.id = 'font-qa-row';
      const measure = (needle) => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          const offset = node.textContent.indexOf(needle);
          if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + needle.length);
          return range.getBoundingClientRect().width;
        }
        throw new Error('Missing terminal glyph: ' + needle);
      };
      return { latin: measure('A'), cjk: measure('中'), punctuation: measure('，') };`);
    assert.ok(Math.abs(grid.cjk - grid.latin * 2) < 1.5, JSON.stringify(grid));
    assert.ok(Math.abs(grid.punctuation - grid.latin * 2) < 1.5, JSON.stringify(grid));
    const terminalFonts = await platformFonts(win, "#font-qa-row");
    assert.ok(terminalFonts.some(font => font.familyName === latin), JSON.stringify(terminalFonts));
    assert.ok(terminalFonts.some(font => font.familyName === chinese), JSON.stringify(terminalFonts));
    const columns = await run("return Number($('.terminal-pane.active').dataset.cols);");
    stream.write("\x1b[2J\x1b[H" + "W".repeat(columns - 2) + "中文Z");
    const wrapped = await run(`await wait(() => $('.terminal-pane.active .xterm-rows').textContent.includes('文Z'));
      const rows = $('.terminal-pane.active .xterm-rows');
      const second = rows.children[1], cursor = second.querySelector('.xterm-cursor');
      if (!cursor) throw new Error('Cursor did not follow the wrapped CJK text');
      return { first: rows.children[0].textContent.trimEnd(), second: second.textContent.trimEnd(),
        cursorX: cursor.getBoundingClientRect().x - second.getBoundingClientRect().x };`);
    assert.equal(wrapped.first, "W".repeat(columns - 2) + "中");
    assert.equal(wrapped.second, "文Z");
    assert.ok(Math.abs(wrapped.cursorX - grid.latin * 3) < 1.5, JSON.stringify(wrapped));

    // Ten thousand families and duplicate styles must not create ten thousand DOM rows or FontFaces.
    await otherRun(`window.__nativeFontQuery = window.queryLocalFonts;
      window.__fontQueryCount = 0;
      window.queryLocalFonts = async () => {
        window.__fontQueryCount++;
        return Array.from({ length: 20000 }, (_, i) => ({ family: 'QA Font ' + String(Math.floor(i / 2)).padStart(5, '0') }));
      };
      window.__fontFaceCount = document.fonts.size;
      await openSettings();`);
    const started = Date.now();
    await click(other, "#settings-font-family-picker");
    await otherRun("await wait(loaded);");
    const large = await otherRun(`const list = $('#font-picker-list');
      if (!$('#font-picker-status').textContent.includes('当前字体')) throw new Error('Missing-font fallback was not explained');
      if (document.fonts.size !== window.__fontFaceCount) throw new Error('Listing loaded unselected fonts');
      list.scrollTop = list.scrollHeight;
      await wait(() => [...document.querySelectorAll('.font-picker-option')].some(row => row.textContent === 'QA Font 09999'));
      return { rows: document.querySelectorAll('.font-picker-option').length, height: $('#font-picker-space').offsetHeight };`);
    assert.ok(large.rows <= 16, JSON.stringify(large));
    assert.equal(large.height, 10000 * 32);
    console.log(`Font catalog: ${names.length} installed families; 10000-family check ${Date.now() - started}ms, ${large.rows} rendered rows`);
    await otherRun(`$('#font-picker-search').value = '09999'; $('#font-picker-search').dispatchEvent(new Event('input'));
      if (document.querySelectorAll('.font-picker-option').length !== 1) throw new Error('Large-list search failed');
      $('#font-picker-search').value = 'not-an-installed-font'; $('#font-picker-search').dispatchEvent(new Event('input'));
      if (document.querySelectorAll('.font-picker-option').length || !$('#font-picker-status').textContent.includes('没有匹配')) throw new Error('No-result search failed');
      window.queryLocalFonts = () => new Promise(resolve => { window.__finishFontQuery = resolve; });
      $('#font-picker-refresh').click();
      $('#font-picker-close').click(); window.__finishFontQuery([{ family: 'Late Font' }]);
      await new Promise(resolve => setTimeout(resolve, 50));
      if (opened()) throw new Error('A late font query reopened the picker');
      $('#settings-font-family-picker').click(); await wait(loaded);
      window.queryLocalFonts = async () => { throw new DOMException('QA denied', 'NotAllowedError'); };
      $('#font-picker-refresh').click(); await wait(() => $('#font-picker-status').textContent.includes('无法读取'));
      if ($('#font-picker-refresh').disabled) throw new Error('Enumeration failure disabled retry');
      window.queryLocalFonts = window.__nativeFontQuery; $('#font-picker-refresh').click(); await wait(loaded);
      if ($('#font-picker-status').textContent.includes('无法读取')) throw new Error('Retry did not recover');
      $('#settings-tab-appearance').click(); if (opened()) throw new Error('Section change left the picker open');
      $('#settings-cancel').click();`);
    console.log("PASS: native font selection, cached enumeration, CJK/Western glyphs, grid widths, wrapping/cursor, cancel/save/sync, large lists and enumeration recovery");
  } finally {
    if (other && !other.isDestroyed()) {
      other.allowClose = true; other.close();
    }
    await run(`window.queryLocalFonts = window.__nativeFontQuery;
      if (opened()) $('#font-picker-close').click();
      if ($('#settings-dialog').open) $('#settings-cancel').click();
      await api.applySettings(${JSON.stringify(original)});
      await openSettings(); $('#settings-cancel').click();`);
  }
}
module.exports = { check };
