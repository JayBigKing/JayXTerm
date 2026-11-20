export function isPasswordPrompt(text) {
  if (typeof text !== "string" || text.length > 512 || /[\r\n\x00-\x1f\x7f]/.test(text)) return false;
  const value = text.trim();
  return /^(?:\[sudo\]\s*)?(?:(?:please|enter|type|current|old|new|retype|repeat|confirm|unix|ldap|\(current\))\s+)*(?:password|passphrase)(?:\s+(?:for\b.*|again))?\s*[:：?？]$/i.test(value) ||
    /^.{1,160}['’]s\s+password\s*[:：?？]$/i.test(value) ||
    /^(?:请)?(?:输入|再次输入|重新输入|确认)?[^$#>]{0,160}(?:密码|口令)(?:[（(][^）)]{0,80}[）)])?\s*[:：?？]$/.test(value);
}

export function terminalPasswordPrompt(term) {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return null;
  let row = buffer.baseY + buffer.cursorY;
  let line = buffer.getLine(row);
  let text = line?.translateToString(false, 0, buffer.cursorX) || "";
  // Reading the parsed buffer handles split SSH packets, ANSI colors and CJK.
  for (let count = 0; line?.isWrapped && row > 0 && count < 4; count++) {
    line = buffer.getLine(--row);
    text = (line?.translateToString(false) || "") + text;
  }
  return isPasswordPrompt(text) ? { text: text.trim(), key: `${buffer.baseY + buffer.cursorY}:${text.trim()}` } : null;
}
