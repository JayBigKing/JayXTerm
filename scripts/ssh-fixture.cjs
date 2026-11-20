const { Server, utils } = require("ssh2");
const { generateKeyPairSync } = require("node:crypto");
const path = require("node:path");
function createFixture({ readline = false } = {}) {
  const sizes = [],
    inputs = [],
    streams = new Set();
  const directory = { path: null, queries: 0 };
  const inputRecords = [];
  let authenticated = 0;
  const files = new Map([
      ["/home/jay/README.md", Buffer.from("JayXTerm SFTP fixture\n")],
    ]),
    dirs = new Set(["/home/jay", "/home/jay/projects"]);
  const modes = new Map();
  const modified = new Map();
  const deniedCreates = new Set();
  const deniedRemovals = new Set();
  const sftpChannels = new Set();
  const clients = new Set();
  const { STATUS_CODE: S } = utils.sftp;
  const server = new Server(
    {
      hostKeys: [
        generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          type: "pkcs1",
          format: "pem",
        }),
      ],
    },
    (c) => {
      clients.add(c);
      c.on("close", () => clients.delete(c));
      c.on("error", () => {});
      c.on("authentication", (ctx) =>
        ctx.method === "password" && ctx.password === "qa-password"
          ? ctx.accept()
          : ctx.reject(),
      );
      c.on("ready", () => {
        authenticated++;
        return c.on("session", (accept) => {
          const session = accept();
          let size = { cols: 100, rows: 30 },
            shell;
          session.on("pty", (accept, _reject, info) => {
            size = { cols: info.cols, rows: info.rows };
            sizes.push(size);
            accept();
          });
          session.on("window-change", (accept, _reject, info) => {
            size = { cols: info.cols, rows: info.rows };
            sizes.push(size);
            if (shell?.stdin.writable)
              shell.stdin.write(
                JSON.stringify({ type: "resize", ...size }) + "\n",
              );
            accept?.();
          });
          session.on("exec", (accept, reject, info) => {
            if (!info.command.includes("JAYXTERM_PTY_CWD") || !directory.path) {
              reject();
              return;
            }
            directory.queries++;
            const stream = accept();
            stream.write("JAYXTERM_PTY_CWD\0" + directory.path + "\0");
            stream.exit(0);
            stream.end();
          });
          session.on("shell", (accept) => {
            const stream = accept();
            streams.add(stream);
            stream.on("close", () => streams.delete(stream));
            stream.on("data", (data) => {
              inputs.push(Buffer.from(data));
              inputRecords.push({ stream, data: Buffer.from(data) });
            });
            if (readline) {
              shell = require("node:child_process").spawn(
                "python3",
                [
                  "-u",
                  path.join(__dirname, "pty-fixture.py"),
                  String(size.cols),
                  String(size.rows),
                ],
                {
                  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
                  stdio: ["pipe", "pipe", "inherit"],
                },
              );
              shell.on("error", (e) => stream.end(e.message));
              shell.stdout.on("data", (data) => stream.write(data));
              stream.on("data", (data) => {
                if (shell.stdin.writable)
                  shell.stdin.write(
                    JSON.stringify({
                      type: "input",
                      data: data.toString("base64"),
                    }) + "\n",
                  );
              });
              stream.on("close", () => shell.stdin.end());
              shell.on("exit", () => stream.end());
              return;
            }
            stream.write(
              "\x1b[32mWelcome to JayXTerm\x1b[0m\r\nUbuntu 24.04 LTS · Internal Development Server\r\n\r\njay@dev-server:~$ ",
            );
            stream.on("data", (d) => stream.write(d));
          });
          session.on("sftp", (accept) => {
            const s = accept();
            sftpChannels.add(s);
            s.once("close", () => sftpChannels.delete(s));
            const handles = new Map();
            let serial = 0;
            const attrs = (p) =>
              dirs.has(p)
                ? { mode: 0o40755, size: 0, mtime: 0, atime: 0, uid: 0, gid: 0 }
                : {
                    mode: modes.get(p) ?? 0o100644,
                    size: files.get(p)?.length || 0,
                    mtime: modified.get(p) ?? 0,
                    atime: 0,
                    uid: 0,
                    gid: 0,
                  };
            const handle = (entry) => {
              const h = Buffer.alloc(4);
              h.writeUInt32BE(++serial);
              handles.set(h.toString("hex"), entry);
              return h;
            };
            s.on("REALPATH", (id, p) =>
              s.name(id, [
                {
                  filename:
                    p === "." ? "/home/jay" : path.posix.resolve("/", p),
                  longname: "",
                  attrs: attrs("/home/jay"),
                },
              ]),
            );
            s.on("OPENDIR", (id, p) =>
              s.handle(id, handle({ path: p, read: false })),
            );
            s.on("READDIR", (id, h) => {
              const entry = handles.get(h.toString("hex"));
              if (entry.read) return s.status(id, S.EOF);
              entry.read = true;
              const names = [...dirs, ...files.keys()].filter(
                (p) => p !== entry.path && path.posix.dirname(p) === entry.path,
              );
              s.name(
                id,
                names.map((p) => ({
                  filename: path.posix.basename(p),
                  longname: p,
                  attrs: attrs(p),
                })),
              );
            });
            for (const op of ["STAT", "LSTAT"])
              s.on(op, (id, p) =>
                dirs.has(p) || files.has(p)
                  ? s.attrs(id, attrs(p))
                  : s.status(id, S.NO_SUCH_FILE),
              );
            s.on("MKDIR", (id, p) => {
              dirs.add(p);
              s.status(id, S.OK);
            });
            s.on("OPEN", (id, p, flags, attributes) => {
              if ((flags & 8) && deniedCreates.has(path.posix.dirname(p)))
                return s.status(id, S.PERMISSION_DENIED);
              if ((flags & 32) && files.has(p)) return s.status(id, S.FAILURE);
              if ((flags & 8) && (!files.has(p) || (flags & 16))) {
                files.set(p, Buffer.alloc(0));
                modes.set(p, 0o100000 | (attributes.mode ?? 0o644));
              }
              if (!files.has(p)) return s.status(id, S.NO_SUCH_FILE);
              s.handle(id, handle({ path: p }));
            });
            s.on("FSETSTAT", (id, h, { mode }) => {
              const p = handles.get(h.toString("hex")).path;
              if (mode !== undefined) modes.set(p, 0o100000 | mode);
              s.status(id, S.OK);
            });
            s.on("RENAME", (id, from, to) => {
              if (!files.has(from)) return s.status(id, S.NO_SUCH_FILE);
              files.set(to, files.get(from));
              modes.set(to, modes.get(from));
              modified.set(to, (modified.get(to) ?? 0) + 1);
              files.delete(from);
              modes.delete(from);
              modified.delete(from);
              s.status(id, S.OK);
            });
            s.on("REMOVE", (id, p) => {
              if (deniedRemovals.has(p)) return s.status(id, S.PERMISSION_DENIED);
              modes.delete(p);
              modified.delete(p);
              s.status(id, files.delete(p) ? S.OK : S.NO_SUCH_FILE);
            });
            s.on("RMDIR", (id, p) => {
              if (deniedRemovals.has(p)) return s.status(id, S.PERMISSION_DENIED);
              if ([...dirs, ...files.keys()].some((entry) => path.posix.dirname(entry) === p))
                return s.status(id, S.FAILURE);
              s.status(id, dirs.delete(p) ? S.OK : S.NO_SUCH_FILE);
            });
            s.on("FSTAT", (id, h) =>
              s.attrs(id, attrs(handles.get(h.toString("hex")).path)),
            );
            s.on("READ", (id, h, offset, length) => {
              const data = files.get(handles.get(h.toString("hex")).path);
              offset >= data.length
                ? s.status(id, S.EOF)
                : s.data(id, data.subarray(offset, offset + length));
            });
            s.on("WRITE", (id, h, offset, data) => {
              const p = handles.get(h.toString("hex")).path,
                old = files.get(p),
                out = Buffer.alloc(Math.max(old.length, offset + data.length));
              old.copy(out);
              data.copy(out, offset);
              files.set(p, out);
              s.status(id, S.OK);
            });
            s.on("CLOSE", (id, h) => {
              handles.delete(h.toString("hex"));
              s.status(id, S.OK);
            });
          });
        });
      });
    },
  );
  return {
    server,
    sizes,
    inputs,
    inputRecords,
    streams,
    directory,
    get authenticated() {
      return authenticated;
    },
    files,
    dirs,
    deniedCreates,
    deniedRemovals,
    async closeSftpChannels() {
      await Promise.all([...sftpChannels].map((channel) => new Promise((resolve) => {
        channel.once("close", resolve);
        channel.end();
      })));
    },
    close() {
      for (const c of clients) {
        c.end();
        c._sock?.destroy();
      }
      server.close();
    },
  };
}
module.exports = { createFixture };
