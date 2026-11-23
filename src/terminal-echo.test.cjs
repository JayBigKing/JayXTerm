const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EchoPrediction } = require("./terminal-echo.mjs");

function trained() {
  const echo = new EchoPrediction();
  echo.input("e", true); echo.output("e");
  echo.input("c", true); echo.output("c");
  return echo;
}
test("prediction requires real echoes and reconciles split and coalesced output", () => {
  const echo = new EchoPrediction();
  echo.input("e", true); echo.input("c", true);
  assert.equal(echo.text, "");
  echo.output("ec");
  for (const c of "ho ") echo.input(c, true);
  assert.equal(echo.text, "ho ");
  echo.output(Uint8Array.from([104]));
  assert.equal(echo.text, "o ");
  echo.output("o ");
  assert.equal(echo.text, "");
});
test("non-echo output cancels predictions and requires new confirmation", () => {
  for (const output of ["X", "ho\r\n", "\x1b[2K", "***", "background output", "中文"]) {
    const echo = trained();
    echo.input("h", true); echo.input("o", true);
    echo.output(output);
    assert.equal(echo.text, "");
    echo.input("s", true);
    assert.equal(echo.text, "");
  }
});
test("Enter, editing keys, paste and CJK discard confidence before another prompt", () => {
  for (const input of ["\r", "\x7f", "\t", "\x03", "\x1b[A", "pasted text", "中"]) {
    const echo = trained();
    echo.input("h", true);
    echo.input(input, true);
    for (const c of "password") echo.input(c, true);
    assert.equal(echo.text, "", "An unconfirmed password must never be predicted");
  }
});
test("disabled or unsafe contexts remove already queued predictions", () => {
  const echo = trained();
  echo.input("h", true);
  assert.equal(echo.text, "h");
  echo.input("x", false);
  assert.equal(echo.text, "");
  echo.input("p", true);
  assert.equal(echo.text, "");
});
