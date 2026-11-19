const assert = require("node:assert/strict");
const fs = require("node:fs");
const { BrowserWindow, dialog } = require("electron");
const iconv = require("iconv-lite");

async function check(w, fixture) {
  const first = "/home/jay/settings.cpp";
  const second = "/home/jay/legacy.txt";
  const cpp = [
    "#include <string>", "#include <vector>", "", "namespace workspace {", "",
    "struct Endpoint {", "    std::string host;", "    unsigned port = 22;", "};", "",
    "// 加载内网环境的服务器配置", "std::vector<Endpoint> loadEndpoints() {",
    '    return {{"build-server", 22}, {"deploy-server", 2007}};',
    "}", "", "bool isDefaultPort(const Endpoint& server) {",
    "    return server.port == 22;", "}", "",
    ...Array.from({ length: 35 }, (_, index) =>
      `constexpr unsigned pipeline_${index + 1} = ${index + 100};`),
    "", "}  // namespace workspace", "",
  ].join("\n");
  fixture.files.set(first, Buffer.from(cpp));
  fixture.files.set(second, iconv.encode("维护窗口\r\n", "gbk"));
  fixture.files.set("/home/jay/image.bin", Buffer.from([0, 1, 2]));
  const run = (win, code) => win.webContents.executeJavaScript(`(async () => {
    const $ = (selector) => document.querySelector(selector);
    const open = (name) => [...document.querySelectorAll("#file-list .file-row")]
      .find((row) => row.querySelector(".filename").textContent === name)
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const wait = async (predicate) => {
      for (let count = 0; count < 150; count++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Editor check timed out: " + predicate + " / " + ($(".editor-message") || $("#toast"))?.textContent);
    };
    const encoding = (choice) => {
      const picker = $(".editor-charset");
      picker.value = choice;
      picker.dispatchEvent(new Event("change"));
    };
    const key = (name, options) => $(".cm-content").dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options }),
    );
    ${code}
  })()`);
  const opened = (name) => BrowserWindow.getAllWindows().find((win) =>
    win.getTitle().startsWith(name + " ·"));
  async function findEditor(name) {
    for (let i = 0; i < 150; i++) {
      const win = opened(name);
      if (win && !win.webContents.isLoading()) return win;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("File window did not open: " + name);
  }
  await run(w, `
    if (performance.getEntriesByType("resource").some((entry) => entry.name.includes("remote-editor")))
      throw new Error("Terminal loaded the editor at startup");
    $("#refresh").click();
    await wait(() => $("#file-list").textContent.includes("settings.cpp"));
    open("image.bin");
    await wait(() => $("#toast").textContent.includes("二进制文件"));
    open("legacy.txt");
  `);
  const legacy = await findEditor("legacy.txt");
  await run(legacy, `
    await wait(() => $(".cm-content")?.textContent.includes("维护窗口"));
    encoding("open:utf-8");
    await wait(() => $(".editor-message").textContent.includes("不是有效的 UTF-8"));
    if (!$(".cm-content").textContent.includes("维护窗口")) throw new Error("Failed reload lost content");
    encoding("open:gbk");
    await wait(() => $(".editor-message").textContent.includes("已按 GBK 重新读取"));
  `);
  await legacy.webContents.insertText("计划");
  const edited = await run(legacy, `
    await wait(() => $(".cm-content").textContent.includes("计划"));
    return [...document.querySelectorAll(".cm-line")].map(line => line.textContent).join("\\r\\n");
  `);
  await run(legacy, `
    $(".cm-content").dispatchEvent(new KeyboardEvent("keydown", {
      key: "s", code: "KeyS", bubbles: true, cancelable: true,
      ctrlKey: !navigator.platform.includes("Mac"),
      metaKey: navigator.platform.includes("Mac"),
    }));
    await wait(() => $(".editor-message").textContent.includes("已保存到远端"));
    if ($(".editor-charset").selectedOptions[0].textContent !== "GBK" ||
        !$(".editor-status").textContent.includes("CRLF"))
      throw new Error("Encoding and line ending not shown");
  `);
  assert.match(edited, /维护窗口/);
  assert.match(edited, /\r\n/);
  assert.deepEqual(fixture.files.get(second), iconv.encode(edited, "gbk"));
  await fixture.closeSftpChannels();
  await run(legacy, `
    encoding("save:utf-8");
    await wait(() => $(".editor-charset").selectedOptions[0].textContent === "UTF-8");
  `);
  assert.equal(fixture.files.get(second).toString(), edited);
  await run(w, `
    if ($("#connected").classList.contains("hidden")) throw new Error("Terminal was hidden");
    open("settings.cpp");
  `);
  const code = await findEditor("settings.cpp");
  assert.notEqual(code.id, legacy.id);
  await run(w, 'open("settings.cpp");');
  assert.equal(opened("settings.cpp").id, code.id);
  assert.equal(BrowserWindow.getAllWindows().filter((win) => win.getTitle().startsWith("settings.cpp ·")).length, 1);
  await run(code, `
    await wait(() => $(".cm-lineNumbers") && $(".editor-map") && !$(".editor-map").hidden);
    if (!$(".editor-status").textContent.includes("C / C++")) throw new Error("Missing language");
    $(".cm-content").focus();
    const original = $(".cm-line").textContent;
    key("Tab");
    if (!/^\\s/.test($(".cm-line").textContent) || !$(".cm-editor.cm-focused"))
      throw new Error("Tab did not indent or lost editor focus");
    key("Tab", { shiftKey: true });
    if ($(".cm-line").textContent !== original)
      throw new Error("Shift+Tab did not undo indentation");
    key("ArrowRight", { shiftKey: true });
    await wait(() => {
      const selection = $(".cm-selectionBackground");
      return selection && getComputedStyle(selection).backgroundColor === "rgb(50, 102, 143)";
    });
  `);
  fs.writeFileSync(".codex-cache/qa/remote-editor.png", (await code.webContents.capturePage()).toPNG());
  await code.webContents.insertText("// 本地草稿\n");
  fixture.files.set(first, Buffer.from("edited externally\n"));
  await run(code, `
    $(".editor-save").click();
    await wait(() => $(".editor-message").textContent.includes("远程文件已更改"));
    if (!$(".cm-content").textContent.includes("本地草稿")) throw new Error("Draft lost on conflict");
  `);
  const originalDialog = dialog.showMessageBox;
  let confirms = 0;
  try {
    dialog.showMessageBox = async () => {
      confirms++;
      return { response: confirms === 1 ? 0 : 1 };
    };
    code.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(code.isDestroyed(), false);
    code.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(code.isDestroyed(), true);
    assert.equal(confirms, 2);
  } finally {
    dialog.showMessageBox = originalDialog;
  }
  legacy.close();
  assert.equal(fixture.files.get(first).toString(), "edited externally\n");
  assert.equal([...fixture.files.keys()].some((name) => name.includes(".jayxterm-edit-")), false);
}

module.exports = { check };
