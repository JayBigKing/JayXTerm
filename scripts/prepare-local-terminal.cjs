const fs = require("node:fs");
const path = require("node:path");

if (process.platform === "darwin") {
  const pty = path.dirname(require.resolve("node-pty/package.json"));
  const helper = path.join(pty, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  // node-pty 1.1.0's npm tarball ships the macOS prebuilt helper without +x.
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
