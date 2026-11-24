const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cache = path.resolve(__dirname, "../.codex-cache");
const output = path.join(cache, "build/native");
const temp = path.join(cache, "tmp");
const headers = process.env.npm_config_nodedir
  ? path.join(process.env.npm_config_nodedir, "include/node")
  : path.resolve(path.dirname(process.execPath), "../include/node");
if (!fs.existsSync(path.join(headers, "node_api.h")))
  throw new Error("找不到 Node.js 头文件，请通过 npm_config_nodedir 指向 Node.js 安装目录");
for (const folder of [output, temp]) fs.mkdirSync(folder, { recursive: true });
const result = spawnSync("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-bundle",
  "-undefined", "dynamic_lookup", "-mmacosx-version-min=12.0",
  "-framework", "AppKit", "-I", headers,
  path.resolve(__dirname, "../native/finder-drag.mm"), "-o", path.join(output, "jayxterm-finder-drag.node")],
{ env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
