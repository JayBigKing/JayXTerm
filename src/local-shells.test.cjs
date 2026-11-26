const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path").win32;
const { discoverShellProfiles } = require("./local-shells.cjs");

const root = "C:\\Windows";
const system = path.join(root, "System32");
const git = "D:\\Development tools\\Git";
const winShells = ["cmd.exe", "wsl.exe", "WindowsPowerShell\\v1.0\\powershell.exe"].map(file => path.join(system, file));

test("Windows prefers Git Bash, keeps CMD next, and lists installed WSL distributions and PowerShell", async () => {
  const files = [...winShells, path.join(git, "bin", "bash.exe"), path.join(git, "usr", "bin", "bash.exe")];
  const profiles = await discoverShellProfiles({
    platform: "win32", env: { SystemRoot: root, Path: `"${path.join(git, "cmd")}"` },
    exists: file => files.includes(file),
    run: async (file, args) => {
      assert.equal(path.basename(file), "wsl.exe");
      assert.deepEqual(args, ["--list", "--quiet"]);
      return Buffer.from("\uFEFFUbuntu\r\nDebian\r\nUbuntu\r\n", "utf16le");
    },
  });
  assert.deepEqual(profiles.map(profile => profile.id), ["git-bash", "cmd", "wsl:Ubuntu", "wsl:Debian", "powershell"]);
  assert.equal(profiles[0].file, path.join(git, "bin", "bash.exe"));
  assert.deepEqual(profiles[2].args, ["--distribution", "Ubuntu", "--cd", "~"]);
});

test("Windows falls back to CMD when Git Bash is absent and ignores disabled WSL", async () => {
  const files = [...winShells, path.join(system, "bash.exe"), path.join(system, "reg.exe")];
  const profiles = await discoverShellProfiles({
    platform: "win32", env: { SystemRoot: root, Path: system },
    exists: file => files.includes(file),
    run: async () => { throw Error("not installed"); },
  });
  assert.deepEqual(profiles.map(profile => profile.id), ["cmd", "powershell"]);
});

test("Windows finds a Git for Windows installation registered outside its default locations", async () => {
  const files = [winShells[0], path.join(system, "reg.exe"), path.join(git, "bin", "bash.exe"), path.join(git, "usr", "bin", "bash.exe")];
  const profiles = await discoverShellProfiles({
    platform: "win32", env: { SystemRoot: root }, exists: file => files.includes(file),
    run: async (_file, [, key]) => {
      if (!key.startsWith("HKLM\\Software\\GitForWindows")) throw Error("missing key");
      return Buffer.from(`    InstallPath    REG_SZ    ${git}\r\n`);
    },
  });
  assert.deepEqual(profiles.map(profile => profile.id), ["git-bash", "cmd"]);
});

test("macOS prefers the account's login shell and skips unavailable entries", async () => {
  const profiles = await discoverShellProfiles({
    platform: "darwin", env: { SHELL: "/removed/fish" }, loginShell: "/bin/bash",
    exists: file => ["/bin/bash", "/bin/zsh"].includes(file),
  });
  assert.deepEqual(profiles.map(({ id, file, args }) => [id, file, args]), [
    ["/bin/bash", "/bin/bash", ["-l"]], ["/bin/zsh", "/bin/zsh", ["-l"]],
  ]);
});
