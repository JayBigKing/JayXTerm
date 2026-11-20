const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTheme, contrast } = require("./theme.mjs");

test("whole-window themes preserve readable text across dark, light and mid-tone colors", () => {
  for (const color of ["#394351", "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#777777", "#888888", "#ff00ff"]) {
    const theme = createTheme(color);
    assert.equal(theme.terminal.background, color);
    assert.equal(theme.editor.colors["editor.background"], color);
    for (const background of [theme.background, theme.chrome, theme.surface]) {
      for (const foreground of [theme.ink, theme.muted, theme.accent])
        assert.ok(contrast(background, foreground) >= 4.5, `${color}: ${foreground} on ${background}`);
    }
  }
  assert.equal(createTheme("invalid").background, "#394351");
  assert.equal(createTheme("#ffffff").editor.base, "vs");
  assert.equal(createTheme("#000000").editor.base, "vs-dark");
});
