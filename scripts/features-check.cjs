const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { BrowserWindow, dialog, Menu } = require("electron");
const { createTheme } = require("../src/theme.mjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let index = 0; index < 150; index++) {
    const result = await check();
    if (result) return result;
    await pause(40);
  }
  throw new Error("Feature check timed out: " + check);
}

async function check(win, fixture) {
  const run = (code) => win.webContents.executeJavaScript(`(async () => {
    const $ = (selector) => document.querySelector(selector);
    const wait = async (check) => {
      for (let i = 0; i < 150; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error("Feature UI timed out: " + check + " / " + $("#toast").textContent);
    };
    ${code}
  })()`);
  const originalDialog = dialog.showMessageBox;
  const buildMenu = Menu.buildFromTemplate;
  const initial = await run("return await api.settings();");
  const source = await run("return $('.tab.active').dataset.connection;");
  let editorWindow, other;
  try {
    // Check saved themes in an existing editor, another window and newly opened windows.
    await run(`await api.openRemoteEditor({ id: ${JSON.stringify(source)}, path: "/home/jay/README.md" });`);
    editorWindow = await waitFor(() => BrowserWindow.getAllWindows().find((item) =>
      item.getTitle().startsWith("README.md ·") && !item.webContents.isLoading()));
    await waitFor(() => editorWindow.webContents.executeJavaScript("!!document.querySelector('.monaco-editor')"));
    const otherId = await run("return await api.newWindow();");
    other = BrowserWindow.getAllWindows().find((item) => item.webContents.id === otherId);
    await other.frontendReady;
    for (const color of ["#f4f0e8", "#224466"]) {
      await run(`
        $('#settings-open').click();
        await wait(() => $('#settings-dialog').open);
        $('#settings-background').value = ${JSON.stringify(color)};
        $('#settings-background').dispatchEvent(new Event('input'));
        $('#settings-form').requestSubmit();
        await wait(() => !$('#settings-dialog').open);
      `);
      const theme = createTheme(color);
      const rgb = (hex) => `rgb(${hex.slice(1).match(/../g).map((value) => parseInt(value, 16)).join(", ")})`;
      await waitFor(() => other.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.sidebar')).backgroundColor === '${rgb(color)}'`));
      await waitFor(() => editorWindow.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor === '${rgb(color)}'`));
      assert.deepEqual(await run(`return ['.sidebar', '.topbar', '.terminal-group-body', '.terminal-pane.active .xterm-viewport']
        .map(selector => getComputedStyle($(selector)).backgroundColor);`),
        [rgb(color), rgb(theme.chrome), rgb(color), rgb(color)]);
      assert.equal(await editorWindow.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.editor-top')).backgroundColor"), rgb(theme.chrome));
      await pause(200);
      assert.equal(await run("return getComputedStyle($('#up')).backgroundColor;"), rgb(theme.chrome));
      fs.writeFileSync(path.resolve(`.codex-cache/qa/theme-${theme.dark ? "dark" : "light"}.png`),
        (await win.webContents.capturePage()).toPNG());
    }
    const freshId = await run("return await api.newWindow();");
    const fresh = BrowserWindow.getAllWindows().find((item) => item.webContents.id === freshId);
    await fresh.frontendReady;
    await waitFor(() => fresh.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.sidebar')).backgroundColor === 'rgb(34, 68, 102)'"));
    fresh.close();
    other.close(); other = null;
    editorWindow.close(); editorWindow = null;
    console.log("PASS: whole-window light/dark themes, terminal, editor and saved settings across windows");

    const deletedFile = "/home/jay/delete '中文 $().txt";
    const deniedFile = "/home/jay/delete-denied.txt";
    fixture.files.set(deletedFile, Buffer.from("delete fixture only"));
    fixture.files.set(deniedFile, Buffer.from("keep on error"));
    fixture.deniedRemovals.add(deniedFile);
    const folder = "/home/jay/delete-tree";
    fixture.dirs.add(folder);
    fixture.dirs.add(folder + "/empty");
    fixture.files.set(folder + "/nested.txt", Buffer.from("nested"));
    await run(`$('#remote-path').value = '/home/jay'; $('#path-form').requestSubmit();
      await wait(() => [...document.querySelectorAll('#file-list .filename')].some(node => node.textContent === ${JSON.stringify(path.posix.basename(deletedFile))}));`);
    let response = 0, confirmations = [];
    dialog.showMessageBox = async (_parent, options) => {
      confirmations.push(options);
      return { response };
    };
    const clickDelete = (name, selector = "#file-list") => run(`
      const row = [...document.querySelectorAll('${selector} .file-row')]
        .find(node => node.querySelector('.filename').textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('Missing deletion target');
      row.querySelector('.delete-one').click();
      await wait(() => [...document.querySelectorAll('${selector} .delete-one')].every(button => !button.disabled));
    `);
    await clickDelete(path.posix.basename(deletedFile));
    assert.ok(fixture.files.has(deletedFile), "Cancel must preserve the remote file");
    assert.equal(confirmations.length, 1);
    assert.ok(confirmations[0].detail.includes(deletedFile));
    assert.equal(confirmations[0].defaultId, 0);
    response = 1;
    await clickDelete(path.posix.basename(deletedFile));
    assert.ok(!fixture.files.has(deletedFile));
    await clickDelete(path.posix.basename(deniedFile));
    assert.ok(fixture.files.has(deniedFile));
    assert.match(await run("return $('#transfer-status').textContent;"), /删除失败/);
    assert.match(await run(`return await api.removeRemote({ id: ${JSON.stringify(source)}, path: '/' }).then(() => '', error => error.message);`), /根目录/);
    fixture.directory.path = "/home/jay";
    await run(`$('#file-workspace-toggle').click();
      await wait(() => [...document.querySelectorAll('.terminal-group.focused .workspace-files .filename')].some(node => node.textContent === 'delete-tree'));`);
    await clickDelete("delete-tree", ".terminal-group.focused .workspace-files");
    assert.ok(!fixture.dirs.has(folder) && !fixture.dirs.has(folder + "/empty"));
    assert.ok(!fixture.files.has(folder + "/nested.txt"));
    await run("$('#file-workspace-toggle').click();");
    console.log("PASS: remote file/directory deletion, cancellation, permissions, root rejection and both file panels");

    // Duplicate through the actual native tab menu. The SFTP browsing path is deliberately different.
    const directory = "/home/jay/中文 ' $(echo wrong) ; %目录";
    fixture.dirs.add(directory);
    fixture.directory.path = directory;
    await run(`await api.encoding({ id: ${JSON.stringify(source)}, encoding: 'gbk' });
      $('#terminal-encoding').value = 'gbk'; $('#terminal-encoding').dispatchEvent(new Event('change'));
      await wait(() => !$('#terminal-encoding').disabled);`);
    const before = fixture.authenticated;
    const originalStreams = new Set(fixture.streams);
    const recordStart = fixture.inputRecords.length;
    const sessionsBefore = await run("return (await api.sessions()).length;");
    let duplicateMenu;
    Menu.buildFromTemplate = (items) => {
      duplicateMenu = items.find((item) => item.label === "复制会话及路径");
      return { popup() { duplicateMenu.click(); } };
    };
    await run(`document.querySelector('.tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await wait(() => document.querySelectorAll('.tab').length === 2 && $('#status').textContent.includes('已连接'));
      await wait(() => $('#remote-path').value === ${JSON.stringify(directory)});`);
    assert.ok(duplicateMenu?.enabled);
    assert.equal(fixture.authenticated, before + 1);
    assert.equal(await run("return (await api.sessions()).length;"), sessionsBefore);
    await waitFor(() => fixture.inputRecords.length > recordStart);
    const records = fixture.inputRecords.slice(recordStart);
    assert.ok(records.every((record) => !originalStreams.has(record.stream)), "Original shell must not receive cd");
    const command = Buffer.concat(records.map((record) => record.data)).toString("ascii");
    const match = /^cd -- "\$\(printf '((?:\\[0-7]{3})+)'\)"\r$/.exec(command);
    assert.ok(match, "Startup command must quote the complete path");
    assert.equal(Buffer.from(match[1].match(/[0-7]{3}/g).map((value) => parseInt(value, 8))).toString("utf8"), directory);
    const shell = process.platform === "win32"
      ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/sh";
    if (fs.existsSync(shell)) {
      const output = execFileSync(shell, ["-c", "cd() { printf '%s\\0' \"$@\"; }; " + command.trimEnd()], { encoding: "utf8" });
      assert.equal(output, "--\0" + directory + "\0", "Shell must receive the literal UTF-8 path");
    }
    assert.equal(await run("return $('#terminal-encoding').value;"), "gbk");
    const duplicate = await run("return $('.tab.active').dataset.connection;");
    assert.notEqual(duplicate, source);
    await run("$('.tab.active .close').click();");
    await waitFor(() => fixture.streams.size === originalStreams.size);
    assert.ok([...originalStreams].every((stream) => fixture.streams.has(stream)));

    // Reuse the live credentials after removing the saved session; never ask for its password again.
    const saved = await run("return (await api.sessions()).find(item => item.name === '本地验收服务器');");
    await run(`await api.remove(${JSON.stringify(saved.id)});`);
    await run(`$('.tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await wait(() => document.querySelectorAll('.tab').length === 2 && $('#status').textContent.includes('已连接'));
      $('.tab.active .close').click();`);
    assert.equal(fixture.authenticated, before + 2);
    assert.equal(await run("return $('#password-dialog').open;"), false);
    const unownedId = await run("return await api.newWindow();");
    other = BrowserWindow.getAllWindows().find((item) => item.webContents.id === unownedId);
    await other.frontendReady;
    for (const method of ["duplicate", "removeRemote"])
      assert.match(await other.webContents.executeJavaScript(
        `api.${method}({id: ${JSON.stringify(source)}, path: '/home/jay/README.md', directory: '/home/jay'}).then(() => '', error => error.message)`),
        /属于其他窗口/);
    other.close(); other = null;
    console.log("PASS: native tab duplication, independent SSH authentication, current path, GBK and live credentials");
  } finally {
    Menu.buildFromTemplate = buildMenu;
    dialog.showMessageBox = originalDialog;
    fixture.directory.path = null;
    editorWindow?.destroy();
    other?.destroy();
    await run(`const saved = ${JSON.stringify(initial)};
      await api.applySettings({ ...saved, cachePath: saved.pendingCache ?? saved.cachePath });`);
  }
}
module.exports = { check };
