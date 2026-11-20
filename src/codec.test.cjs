const { test } = require("node:test");
const assert = require("node:assert/strict");
const iconv = require("iconv-lite");
const { TerminalCodec, normalizeEncoding } = require("./codec.cjs");
test("GBK decoding survives every packet boundary and preserves Vim control sequences", () => {
  const text =
    "\x1b[?1049h\x1b[1;1H中文测试，旧系统文件\x1b[31m红色\x1b[0m\x1b[?1049l";
  const bytes = iconv.encode(text, "gbk");
  for (let i = 0; i <= bytes.length; i++) {
    const codec = new TerminalCodec("gbk");
    assert.equal(
      Buffer.concat([
        codec.decode(bytes.subarray(0, i)),
        codec.decode(bytes.subarray(i)),
      ]).toString("utf8"),
      text,
    );
  }
  const codec = new TerminalCodec("gbk");
  assert.deepEqual(
    codec.encode("中文输入\r\x1b[A"),
    iconv.encode("中文输入\r\x1b[A", "gbk"),
  );
});
test("encoding switching isolates decoders and leaves UTF-8 bytes for xterm streaming", () => {
  const codec = new TerminalCodec();
  const bytes = Buffer.from("中文", "utf8");
  assert.deepEqual(codec.decode(bytes.subarray(0, 1)), bytes.subarray(0, 1));
  codec.setEncoding("gbk");
  const chinese = iconv.encode("中", "gbk");
  assert.equal(codec.decode(chinese.subarray(0, 1)).length, 0);
  codec.setEncoding("gbk");
  assert.equal(codec.decode(chinese.subarray(1)).toString(), "中");
  codec.setEncoding("utf-8");
  assert.deepEqual(codec.encode("中文"), bytes);
  assert.equal(normalizeEncoding("CP936"), "gbk");
  assert.throws(() => normalizeEncoding("unsupported"));
});
test("GB2312 preserves Chinese input, split packets and switching back to UTF-8", () => {
  const bytes = Buffer.from("d6d0cec4b2e2cad4", "hex");
  for (let index = 0; index <= bytes.length; index++) {
    const codec = new TerminalCodec("GB2312");
    assert.equal(Buffer.concat([codec.decode(bytes.subarray(0, index)), codec.decode(bytes.subarray(index))]).toString(), "中文测试");
    assert.deepEqual(codec.encode("中文测试"), bytes);
    codec.setEncoding("utf-8");
    assert.deepEqual(codec.encode("中文测试"), Buffer.from("中文测试"));
  }
  assert.equal(normalizeEncoding("GB-2312"), "gb2312");
});
