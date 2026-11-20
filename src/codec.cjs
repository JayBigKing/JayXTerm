const iconv = require("iconv-lite");
function normalizeEncoding(value = "utf-8") {
  const encoding = String(value).toLowerCase();
  if (["utf-8", "utf8"].includes(encoding)) return "utf-8";
  if (["gbk", "cp936"].includes(encoding)) return "gbk";
  if (["gb2312", "gb-2312"].includes(encoding)) return "gb2312";
  throw new Error("不支持的终端编码");
}
class TerminalCodec {
  constructor(encoding) {
    this.setEncoding(encoding);
  }
  setEncoding(value) {
    const encoding = normalizeEncoding(value);
    if (this.encoding === encoding) return Buffer.alloc(0);
    const tail = this.decoder?.end() || "";
    this.encoding = encoding;
    this.decoder = encoding === "utf-8" ? null : iconv.getDecoder(encoding);
    return Buffer.from(tail, "utf8");
  }
  decode(data) {
    return this.decoder ? Buffer.from(this.decoder.write(data), "utf8") : data;
  }
  encode(text) {
    return iconv.encode(text, this.encoding);
  }
}
module.exports = { TerminalCodec, normalizeEncoding };
