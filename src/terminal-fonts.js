import { cjkFontAlias, cjkUnicodeRange, validFontFamily } from "./terminal-settings.mjs";

let currentFamily = "", currentFace, loading = Promise.resolve();

// Only load the selected Chinese font. Other installed fonts stay as names in
// the picker, and the document retains at most one CJK override.
export function prepareTerminalFont(settings) {
  const family = validFontFamily(settings.cjkFontFamily) ? settings.cjkFontFamily.trim() : "";
  if (family === currentFamily) return loading;
  currentFamily = family;
  if (currentFace) document.fonts.delete(currentFace);
  currentFace = null;
  if (!family) return loading = Promise.resolve();
  const face = new FontFace(cjkFontAlias(family), `local("${family}")`, { unicodeRange: cjkUnicodeRange });
  currentFace = face;
  document.fonts.add(face);
  // A font saved on another machine may be absent here; the normal fallback
  // chain remains usable without blocking settings or terminal input.
  return loading = face.load().catch(() => {});
}
