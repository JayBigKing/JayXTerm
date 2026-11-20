const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { dialog } = require("electron");

async function check(window) {
  const folder = path.resolve(".codex-cache/qa/session-exchange");
  await fs.mkdir(folder, { recursive: true });
  const ssh = path.join(folder, "config");
  const xsh = path.join(folder, "导入示例.xsh");
  const exported = path.join(folder, "portable.config");
  await fs.writeFile(ssh, `Host current
  HostName existing.example.net
  Port 2007
  User ops
Host test
  HostName test.example.net
  User ops
Host proxy
  ProxyJump gateway
`);
  await fs.writeFile(xsh, Buffer.from("\ufeff[CONNECTION]\r\nHost=xshell.example.net\r\n" +
    "Protocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=ops\r\nPassword=ignored\r\n", "utf16le"));
  const originalOpen = dialog.showOpenDialog, originalSave = dialog.showSaveDialog;
  const run = (code) => window.webContents.executeJavaScript(`(async () => {
    const $ = (selector) => document.querySelector(selector);
    const menu = () => {
      if (!$("#window-tools-options").matches(":popover-open")) $("#window-tools-menu").click();
    };
    const wait = async (test, stage) => {
      for (let i = 0; i < 100; i++) {
        if (test()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error("Session exchange timed out at " + stage + ": " +
        [$("#toast"), $("#session-import-source"), $("#session-import-summary"), $("#session-import-error")]
          .map(node => node.textContent).join(" / "));
    };
    ${code}
  })()`);
  try {
    dialog.showOpenDialog = async (_parent, options) => ({
      canceled: false, filePaths: [options.filters[0].extensions.includes("xsh") ? xsh : ssh],
    });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported });
    await run(`
      const saved = await api.save({ name:"已有会话", host:"existing.example.net", port:2007,
        username:"ops", group:"原分组", encoding:"gbk", password:"exchange-example", remember:true });
      const id = saved.find(s => s.name === "已有会话").id;
      menu();
      if (!$("#window-tools-menu").textContent.includes("工作台") || !$("#new-window") || !$("#export-openssh"))
        throw Error("Combined workbench menu missing");
      $("#import-openssh").click();
      await wait(() => $("#session-import-dialog").open, "OpenSSH preview");
      if ((await api.sessions()).length !== saved.length) throw Error("Preview wrote sessions");
      const choice = $(".session-import-row select");
      if (choice.value !== "skip" || !$("#session-import-rows").textContent.includes("ProxyJump"))
        throw Error("Duplicate or unsupported host was not skipped");
      choice.value = "update:" + id;
      choice.dispatchEvent(new Event("change"));
      if (!$("#session-import-summary").textContent.includes("更新 1") ||
          !$(".import-changes").textContent.includes("已有会话 → current"))
        throw Error("Update summary missing");
      $("#session-import-apply").click();
      await wait(() => !$("#session-import-dialog").open, "OpenSSH apply");
      const sessions = await api.sessions();
      const updated = sessions.find(s => s.id === id);
      if (updated.name !== "current" || updated.group !== "原分组" || updated.encoding !== "gbk" ||
          !updated.hasPassword || await api.reveal(id) !== "exchange-example" ||
          !sessions.some(s => s.name === "test") || sessions.some(s => s.name === "proxy"))
        throw Error("Incorrect import merge");
      menu();
      $("#import-xshell").click();
      await wait(() => $("#session-import-dialog").open, "Xshell preview");
      if (!$("#session-import-rows").textContent.includes("导入示例")) throw Error("Xshell preview missing");
      $("#session-import-cancel").click();
      if ((await api.sessions()).some(s => s.host === "xshell.example.net")) throw Error("Cancel applied changes");
      menu();
      $("#import-xshell").click();
      await wait(() => $("#session-import-dialog").open, "Xshell reopen");
      $("#session-import-apply").click();
      await wait(() => !$("#session-import-dialog").open, "Xshell apply");
      const imported = (await api.sessions()).find(s => s.host === "xshell.example.net");
      if (!imported || imported.hasPassword) throw Error("Xshell import did not keep credentials separate");
      menu();
      $("#export-openssh").click();
      await wait(() => $("#toast").textContent.includes("已导出"), "OpenSSH export");
    `);
    const text = await fs.readFile(exported, "utf8");
    assert.match(text, /Host current\n    HostName existing\.example\.net\n    Port 2007\n    User "ops"/);
    assert.doesNotMatch(text, /exchange-example|ignored|ProxyJump/);
    console.log("PASS: Workbench menu, OpenSSH import preview/update, Xshell preview/cancel and OpenSSH export");
  } finally {
    dialog.showOpenDialog = originalOpen;
    dialog.showSaveDialog = originalSave;
  }
}

module.exports = { check };
