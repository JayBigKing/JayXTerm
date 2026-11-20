const test = require("node:test");
const assert = require("node:assert/strict");
const { keywordMatches, visibleKeywordSpans } = require("./terminal-keywords.mjs");
const { isPasswordPrompt, terminalPasswordPrompt } = require("./terminal-password-prompt.mjs");

test("log keywords match whole words, case variants and Chinese outcomes", () => {
  const text = "Success FAIL [Warning] info DEBUG 成功 失败 错误 警告 超时 unsuccessful failover success_rate myError FailedTask";
  assert.deepEqual(keywordMatches(text).map(match => [text.slice(match.start, match.end), match.kind]), [
    ["Success", "success"], ["FAIL", "danger"], ["Warning", "warning"], ["info", "info"], ["DEBUG", "info"],
    ["成功", "success"], ["失败", "danger"], ["错误", "danger"], ["警告", "warning"], ["超时", "warning"],
  ]);
  assert.equal(keywordMatches("xSuccess Success1 pre_success failCount").length, 0);
});

function cell(chars, width = 1) { return { getChars: () => chars, getWidth: () => width }; }
function line(cells, isWrapped = false) {
  return { isWrapped, getCell: x => cells[x] || cell(" "), translateToString: (_trim, start = 0, end = cells.length) =>
    cells.slice(start, end).map(item => item.getChars()).join("") };
}
function buffer(lines, viewportY = 0) {
  return { type: "normal", length: lines.length, viewportY, getLine: row => lines[row] };
}
test("keyword decorations use terminal cell widths and span soft wraps only", () => {
  const unicode = line([cell("中", 2), cell("", 0), cell("🙂", 2), cell("", 0), cell("é"), cell(" "),
    ...Array.from("Success", char => cell(char))]);
  assert.deepEqual(visibleKeywordSpans(buffer([unicode]), 16, 1).get(0), [{ row: 0, x: 6, width: 7, kind: "success" }]);
  const rows = [line(Array.from("x Succes", char => cell(char))), line(Array.from("s FAIL  ", char => cell(char)), true)];
  const spans = visibleKeywordSpans(buffer(rows), 8, 2);
  assert.deepEqual(spans.get(0), [{ row: 0, x: 2, width: 6, kind: "success" }]);
  assert.deepEqual(spans.get(1), [{ row: 1, x: 0, width: 1, kind: "success" }, { row: 1, x: 2, width: 4, kind: "danger" }]);
  assert.deepEqual([...visibleKeywordSpans(buffer(rows, 1), 8, 1).keys()], [1]);
  rows[1].isWrapped = false;
  assert.equal(visibleKeywordSpans(buffer(rows), 8, 2).has(0), false);
});

test("password suggestions recognize input prompts, not commands or completed messages", () => {
  for (const text of ["Password: ", "[sudo] password for jay:", "Enter passphrase for key '/home/jay/.ssh/id_ed25519':",
    "root@server's password:", "(current) UNIX password:", "Retype new password:", "Password for 'https://user@example.test':",
    "请输入密码：", "输入虚拟机1密码：", "确认口令："])
    assert.equal(isPasswordPrompt(text), true, text);
  for (const text of ["Password changed successfully", "password=example", "Password: example", "Password:\n$ ",
    "user@server:~$ echo password:", "No password required", "请输入密码：完成", "Success", "x".repeat(513) + " password:"])
    assert.equal(isPasswordPrompt(text), false, text);
  const normal = { ...buffer([line(Array.from("Password: ", char => cell(char)))]), baseY: 0, cursorY: 0, cursorX: 10 };
  assert.equal(terminalPasswordPrompt({ buffer: { active: normal } }).text, "Password:");
  assert.equal(terminalPasswordPrompt({ buffer: { active: { ...normal, type: "alternate" } } }), null);
});
