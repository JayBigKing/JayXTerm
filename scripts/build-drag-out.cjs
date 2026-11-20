const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".codex-cache");
const output = path.join(cache, "build", "native");
const temp = path.join(cache, "tmp");
const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
const source = path.join(root, "native", "drag-out.cpp");
const executable = path.join(output, "jayxterm-drag.exe");
for (const folder of [output, temp]) fs.mkdirSync(folder, { recursive: true });
const libraries = ["ole32", "shlwapi", "shell32", "crypt32", "uuid", "user32"];
const options = { cwd: output, env, stdio: "inherit" };

let build;
if (process.platform === "win32") {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const result = spawnSync(vswhere, ["-latest", "-products", "*", "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
    { env, encoding: "utf8" });
  if (!result.stdout?.trim())
    throw new Error("Building on Windows requires Visual Studio Build Tools with Desktop development with C++.");
  const setup = path.join(result.stdout.trim(), "VC", "Auxiliary", "Build", "vcvars64.bat");
  const command = `"${setup}" && cl /nologo /std:c++17 /EHsc /O2 /MT /DNOMINMAX "${source}" /Fe:jayxterm-drag.exe /Fo:drag-out.obj /link ${libraries.map((name) => name + ".lib").join(" ")}`;
  build = spawnSync("cmd.exe", ["/d", "/s", "/c", '"' + command + '"'],
    { ...options, windowsVerbatimArguments: true });
} else {
  env.ZIG_GLOBAL_CACHE_DIR = path.join(cache, "zig", "global");
  env.ZIG_LOCAL_CACHE_DIR = path.join(cache, "zig", "local");
  build = spawnSync("zig", ["c++", "-target", "x86_64-windows-gnu", "-std=c++17",
    "-O2", "-s", source, "-o", executable, ...libraries.map((name) => "-l" + name)], options);
}
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
