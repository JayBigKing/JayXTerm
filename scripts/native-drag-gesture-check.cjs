// Requires an unlocked Windows desktop. Exercise the real OLE helper and mouse
// queue; simulated IPC helpers cannot detect a stuck DoDragDrop input loop.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const assert = require("node:assert/strict");
app.setPath("userData", path.resolve(".codex-cache/qa/native-gesture-profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let helper, mouse, win;
  const deadline = setTimeout(() => { mouse?.kill(); helper?.kill(); app.exit(1); }, 20000);
  try {
    assert.equal(process.platform, "win32");
    win = new BrowserWindow({ width: 500, height: 260, x: 60, y: 60,
      webPreferences: { contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL("data:text/html," + encodeURIComponent(`<body style="background:#253448;color:white;padding:30px">
      Native drag regression check
      <script>window.tokens=[];document.ondragover=e=>e.preventDefault();
      document.ondrop=e=>{e.preventDefault();tokens.push(e.dataTransfer.getData('text/plain'));};</script>`));
    win.show(); win.focus();
    helper = spawn(path.resolve(".codex-cache/build/native/jayxterm-drag.exe"), [],
      { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
    const lines = readline.createInterface({ input: helper.stdout, crlfDelay: Infinity });
    const received = [];
    lines.on("line", line => received.push(line));
    for (const [index, action] of ["cancel", "drop", "cancel"].entries()) {
      const token = "gesture-" + index;
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { lines.off("line", listen); reject(Error("Native drag did not release after " + action)); }, 5000);
        function listen(line) {
          if (!line.startsWith("done\t" + token + "\t")) return;
          clearTimeout(timer); lines.off("line", listen); resolve(line.split("\t")[2]);
        }
        lines.on("line", listen);
      });
      // Install rejection handling before starting the mouse process.
      completed.catch(() => {});
      win.focus();
      const bounds = win.getContentBounds();
      mouse = spawn("powershell.exe", ["-NoProfile", "-File", path.join(__dirname, "native-drag-mouse.ps1"),
        "-X", String(bounds.x + 120), "-Y", String(bounds.y + 100), "-Action", action],
        { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
      const input = readline.createInterface({ input: mouse.stdout });
      input.on("line", line => {
        if (line === "pressed") helper.stdin.write("drag\t" + token + "\t" +
          Buffer.from("jayxterm-sftp:" + token).toString("base64") + "\n");
      });
      await new Promise((resolve, reject) => {
        mouse.once("error", reject); mouse.once("exit", code => code === 0 ? resolve() : reject(Error("Mouse fixture failed")));
      });
      assert.equal(await completed, action === "cancel" ? "cancelled" : "copy");
    }
    assert.deepEqual(await win.webContents.executeJavaScript("window.tokens"), ["jayxterm-sftp:gesture-1"]);
    assert.ok(!received.some(line => /^(manifest|file)\t/.test(line)), "Internal drops must not read remote files");
    console.log("PASS: real Windows OLE cancel, drop, cancel/retry; source input queue and relay token");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(deadline); mouse?.kill(); helper?.kill(); win?.destroy(); app.exit(process.exitCode || 0); }
});
