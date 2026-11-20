// Exercises the same pipe protocol as the Windows OLE helper.
const { createInterface } = require("node:readline");
const { readFileSync, appendFileSync } = require("node:fs");
const path = require("node:path");

const log = path.resolve(__dirname, "../.codex-cache/qa/local-drag.jsonl");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (line) => console.log(line);
const decode = (text) => Buffer.from(text, "base64").toString("utf8");
let token;
let length;
let entries;
let files;
let index;

function finish(status) {
  appendFileSync(log, JSON.stringify({ entries, files, status }) + "\n");
  send(`done\t${token}\t${status}`);
}

function nextFile() {
  index = entries.findIndex((entry, i) => i > index && !entry.directory && entry.size > 0);
  if (index === -1) finish("copy");
  else send(`file\t${token}\t${index}`);
}

lines.on("line", (line) => {
  const [action, value, size] = line.split("\t");
  if (action === "drag") {
    token = value;
    entries = [];
    files = [];
    length = 0;
    index = -1;
    send("manifest\t" + token);
  } else if (action === "entries") {
    length = Number(value);
  } else if (action === "path") {
    files.push({ name: entries[index].name, bytes: readFileSync(decode(value)).toString("hex") });
    nextFile();
  } else if (action === "error") {
    finish("failed");
  } else {
    entries.push({ name: decode(action), directory: value === "1", size: Number(size) });
    if (entries.length === length) {
      if (entries[0].name === "cancel.bin") finish("cancelled");
      else if (entries[0].name === "rejected.bin") finish("rejected");
      else nextFile();
    }
  }
});
send("ready");
