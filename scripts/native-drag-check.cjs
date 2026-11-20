const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cwd = path.resolve(".codex-cache", "qa", "native-drag");
const fixture = path.join(cwd, "drop-test.bin");
const executable = path.resolve(".codex-cache", "build", "native", "jayxterm-drag.exe");
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(fixture, Buffer.from([0, 255, 10, 13, 128]));
try {
  const result = spawnSync(executable, ["--self-test"], { cwd, stdio: "inherit", timeout: 15000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(fixture, { force: true });
}
