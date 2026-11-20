export const terminalDefaults = {
  fontFamily: "Cascadia Mono",
  fontSize: 14,
  defaultEncoding: "utf-8",
  highlightKeywords: true,
};
export const terminalEncodings = ["utf-8", "gbk", "gb2312"];
export const validFontFamily = (value) => typeof value === "string" && value.trim().length > 0 &&
  value.length <= 100 && !/[\x00-\x1f\x7f"'\\;,{}<>]/.test(value);
export const validFontSize = (value) => Number.isInteger(value) && value >= 8 && value <= 48;
export function terminalFont(settings) {
  const family = validFontFamily(settings.fontFamily) ? settings.fontFamily.trim() : terminalDefaults.fontFamily;
  return {
    fontFamily: `"${family}", Consolas, "Liberation Mono", monospace`,
    fontSize: validFontSize(settings.fontSize) ? settings.fontSize : terminalDefaults.fontSize,
  };
}
