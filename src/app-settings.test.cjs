const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openAppSettings } = require("./app-settings.cjs");

function setup(t) {
  const temp = path.resolve(".codex-cache/tmp");
  fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, "settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile");
  const file = path.join(profile, "settings.json");
  const cryptoStub = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "secure-test-backend",
    encryptString: () => Buffer.from("ciphertext"),
    decryptString: (bytes) => {
      assert.equal(bytes.toString(), "ciphertext");
      return "132exampleio";
    },
  };
  const open = () => openAppSettings(file, profile, cryptoStub);
  return { root, profile, file, open };
}
test("password history is opt-in, encrypted separately, deduplicated, and cleared on disable", (t) => {
  const { file, open } = setup(t);
  let settings = open();
  assert.equal(settings.describe().backgroundColor, "#394351");
  settings.record("132exampleio");
  assert.deepEqual(settings.listHistory(), { enabled: false, items: [] });
  settings.apply({ cachePath: "", saveHistory: true, fileOpen: "single", backgroundColor: "#253448" });
  settings.record("132exampleio");
  settings = open();
  assert.equal(settings.describe().backgroundColor, "#253448");
  settings.record("132exampleio");
  const { items } = settings.listHistory();
  assert.equal(items.length, 1);
  assert.match(items[0].label, /^13\*+io$/);
  assert.equal(settings.selectPassword(items[0].id), "132exampleio");
  assert.equal(settings.describe().fileOpen, "single");
  assert.equal(fs.readFileSync(file, "utf8").includes("132exampleio"), false);
  settings.apply({ cachePath: "", saveHistory: false, fileOpen: "double" });
  settings = open();
  assert.deepEqual(settings.listHistory(), { enabled: false, items: [] });
  assert.equal(settings.selectPassword(items[0].id), "");
  assert.equal(JSON.parse(fs.readFileSync(file)).passwordHistory.length, 0);
});
test("only legacy defaults follow the new workspace background", (t) => {
  const { file, profile, open } = setup(t);
  fs.mkdirSync(profile);
  fs.writeFileSync(file, JSON.stringify({ backgroundColor: "#eff1f5" }));
  assert.equal(open().describe().backgroundColor, "#394351");
  fs.writeFileSync(file, JSON.stringify({ backgroundColor: "#284362" }));
  const settings = open();
  assert.equal(settings.describe().backgroundColor, "#284362");
  const update = { cachePath: "", saveHistory: false, fileOpen: "double" };
  settings.apply({ ...update, backgroundColor: "#eff1f5" });
  assert.equal(open().describe().backgroundColor, "#eff1f5");
  settings.apply({ ...update, backgroundColor: "#394351" });
  assert.equal(open().describe().backgroundColor, "#394351");
});
test("terminal preferences migrate, persist, validate and survive unrelated setting updates", (t) => {
  const { file, open } = setup(t);
  const initial = open().describe();
  assert.equal(initial.fontFamily, "Cascadia Mono");
  assert.equal(initial.cjkFontFamily, "");
  assert.equal(initial.fontSize, 14);
  assert.equal(initial.defaultEncoding, "utf-8");
  assert.equal(initial.highlightKeywords, true);
  const base = { cachePath: "", saveHistory: false, fileOpen: "double" };
  open().apply({ ...base, fontFamily: " Consolas ", cjkFontFamily: " Microsoft YaHei ", fontSize: 20, defaultEncoding: "gb2312", highlightKeywords: false });
  const reloaded = open();
  assert.equal(reloaded.describe().fontFamily, "Consolas");
  assert.equal(reloaded.describe().cjkFontFamily, "Microsoft YaHei");
  assert.equal(reloaded.describe().fontSize, 20);
  assert.equal(reloaded.describe().defaultEncoding, "gb2312");
  assert.equal(reloaded.describe().highlightKeywords, false);
  reloaded.apply({ ...base, backgroundColor: "#ffffff" });
  assert.equal(open().describe().fontSize, 20);
  assert.equal(open().describe().cjkFontFamily, "Microsoft YaHei");
  assert.equal(open().describe().highlightKeywords, false);
  const previous = fs.readFileSync(file, "utf8");
  for (const invalid of [{ fontSize: 7 }, { fontSize: 49 }, { fontSize: 14.5 }, { fontSize: "20" },
    { fontFamily: "" }, { fontFamily: "   " }, { fontFamily: "bad; family" },
    { cjkFontFamily: null }, { cjkFontFamily: "   " }, { cjkFontFamily: 'bad" font' },
    { defaultEncoding: "latin1" }, { highlightKeywords: "yes" }]) {
    assert.throws(() => open().apply({ ...base, ...invalid }), /终端设置/);
    assert.equal(fs.readFileSync(file, "utf8"), previous);
  }
  reloaded.apply({ ...base, cjkFontFamily: "" });
  assert.equal(open().describe().cjkFontFamily, "");
  // Existing installations keep their chosen font and gain automatic CJK fallback.
  fs.writeFileSync(file, JSON.stringify({ fontFamily: "Consolas", fontSize: 16 }));
  assert.equal(open().describe().fontFamily, "Consolas");
  assert.equal(open().describe().cjkFontFamily, "");
  fs.writeFileSync(file, JSON.stringify({ fontSize: -1, fontFamily: null, defaultEncoding: "invalid" }));
  assert.equal(open().describe().fontSize, 14);
  assert.equal(open().describe().fontFamily, "Cascadia Mono");
  assert.equal(open().describe().defaultEncoding, "utf-8");
});
test("cache changes apply on restart and migrate cache folders without copying the user profile", (t) => {
  const { root, profile, open } = setup(t);
  const cache = path.join(profile, "Cache");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "index"), "cache content");
  fs.writeFileSync(path.join(profile, "sessions.json"), "{}");
  const target = path.join(root, "storage", "JayXTerm-cache");
  const settings = open();
  assert.equal(settings.initializeCache(), profile);
  settings.apply({ cachePath: target, migrate: true, saveHistory: false, fileOpen: "double" });
  assert.equal(settings.describe().pendingCache, target);
  assert.equal(fs.existsSync(path.join(target, "Cache")), false);
  const restarted = open();
  assert.equal(restarted.initializeCache(), target);
  assert.equal(fs.readFileSync(path.join(target, "Cache", "index"), "utf8"), "cache content");
  assert.equal(fs.existsSync(path.join(target, "sessions.json")), false);
  assert.equal(restarted.describe().pendingCache, null);
  restarted.apply({ cachePath: "", migrate: false, saveHistory: false, fileOpen: "double" });
  assert.equal(open().initializeCache(), profile);
});
