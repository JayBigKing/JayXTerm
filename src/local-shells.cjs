const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const win = path.win32;

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function wslNames(output) {
  const encoding = (output[0] === 0xFF && output[1] === 0xFE) || output.includes(0) ? "utf16le" : "utf8";
  const lines = output.toString(encoding).replace(/^\uFEFF/, "").split(/\r?\n/);
  return [...new Set(lines.map(line => line.trim()).filter(line => line && !/[\x00-\x1F\x7F]/.test(line)))];
}

function systemPath(env) {
  return (env.Path || env.PATH || "").split(";")
    .map(entry => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(entry => win.isAbsolute(entry));
}

async function gitBash({ env, bin, dirs, exists, run }) {
  const installed = root => root && win.isAbsolute(root) &&
    exists(win.join(root, "usr", "bin", "bash.exe")) && exists(win.join(root, "bin", "bash.exe"));
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter(Boolean).map(folder => win.join(folder, "Git"));
  if (env.LOCALAPPDATA) roots.push(win.join(env.LOCALAPPDATA, "Programs", "Git"));
  for (const directory of dirs) roots.push(directory, win.dirname(directory));
  const found = roots.find(installed);
  if (found) return win.join(found, "bin", "bash.exe");
  const reg = win.join(bin, "reg.exe");
  if (!exists(reg)) return null;
  const keys = ["HKCU\\Software\\GitForWindows", "HKLM\\Software\\GitForWindows",
    "HKLM\\Software\\WOW6432Node\\GitForWindows"];
  const registered = await Promise.all(keys.map(async key => {
    try {
      const result = await run(reg, ["query", key, "/v", "InstallPath"]);
      return /^\s*InstallPath\s+REG_SZ\s+(.+?)\s*$/im.exec(result.toString())?.[1];
    } catch {
      return null;
    }
  }));
  const root = registered.find(installed);
  return root ? win.join(root, "bin", "bash.exe") : null;
}

async function windowsProfiles(env, exists, run) {
  const bin = win.join(env.SystemRoot || "C:\\Windows", "System32");
  const dirs = systemPath(env);
  const wsl = win.join(bin, "wsl.exe");
  const [bash, distros] = await Promise.all([
    gitBash({ env, bin, dirs, exists, run }),
    exists(wsl) ? run(wsl, ["--list", "--quiet"]).then(wslNames, () => []) : [],
  ]);
  const profiles = [];
  const add = (id, name, file, args = [], extra = {}) => {
    if (file && exists(file)) profiles.push({ id, name, file, args, ...extra });
  };
  add("git-bash", "Git Bash", bash, ["--login", "-i"], { env: { CHERE_INVOKING: "1" } });
  add("cmd", "CMD", win.join(bin, "cmd.exe"));
  for (const distro of distros)
    add(`wsl:${distro}`, `WSL · ${distro}`, wsl, ["--distribution", distro, "--cd", "~"]);
  add("powershell", "Windows PowerShell", win.join(bin, "WindowsPowerShell", "v1.0", "powershell.exe"));
  const pwsh = [...dirs.map(dir => win.join(dir, "pwsh.exe")),
    win.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")].find(exists);
  add("pwsh", "PowerShell 7", pwsh);
  return profiles;
}

async function discoverShellProfiles({ platform = process.platform, env = process.env, exists = executable,
  loginShell, run = async (file, args) => (await exec(file, args, {
    encoding: "buffer", windowsHide: true, timeout: 2000, maxBuffer: 65536,
  })).stdout,
} = {}) {
  if (platform === "win32") return windowsProfiles(env, exists, run);
  const candidates = [loginShell ?? os.userInfo().shell, env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  const shells = [...new Set(candidates.filter(file => file && path.posix.isAbsolute(file) && exists(file)))];
  return shells.map(file => ({
    id: file,
    name: path.posix.basename(file),
    file,
    args: ["-l"],
  }));
}

module.exports = { discoverShellProfiles };
