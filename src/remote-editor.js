import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import "./remote-editor.css";

async function languageFor(name) {
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(name)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return ["JavaScript / TypeScript", javascript({
      jsx: /\.[jt]sx$/i.test(name),
      typescript: /\.tsx?$/i.test(name),
    })];
  }
  if (/\.(c|cc|cpp|cxx|h|hpp)$/i.test(name)) {
    const { cpp } = await import("@codemirror/legacy-modes/mode/clike");
    return ["C / C++", StreamLanguage.define(cpp)];
  }
  if (/\.py$/i.test(name)) {
    const { python } = await import("@codemirror/lang-python");
    return ["Python", python()];
  }
  if (/\.json$/i.test(name)) {
    const { json } = await import("@codemirror/lang-json");
    return ["JSON", json()];
  }
  if (/\.ya?ml$/i.test(name)) {
    const { yaml } = await import("@codemirror/lang-yaml");
    return ["YAML", yaml()];
  }
  if (/\.(sh|bash|zsh)$/i.test(name) || /^\.(bash|zsh)(rc|_profile|_aliases)$/.test(name)) {
    const { shell } = await import("@codemirror/legacy-modes/mode/shell");
    return ["Shell", StreamLanguage.define(shell)];
  }
  if (/\.md$/i.test(name)) {
    const { markdown } = await import("@codemirror/lang-markdown");
    return ["Markdown", markdown()];
  }
  if (/\.html?$/i.test(name)) {
    const { html } = await import("@codemirror/legacy-modes/mode/xml");
    return ["HTML", StreamLanguage.define(html)];
  }
  if (/\.css$/i.test(name)) {
    const { css } = await import("@codemirror/legacy-modes/mode/css");
    return ["CSS", StreamLanguage.define(css)];
  }
  return ["纯文本", []];
}

const theme = EditorView.theme({
  "&": { height: "100%", color: "#dce6f4", backgroundColor: "#15191f" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "Consolas, 'SF Mono', monospace",
    fontSize: "13px",
    caretColor: "#79e4cb",
    padding: "12px 0",
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    color: "#8397ad",
    backgroundColor: "#15191f",
    borderRight: "1px solid #202c3d",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#202836" },
  ".cm-cursor": { borderLeft: "2px solid #a2ffe4" },
  ".cm-selectionBackground": { background: "#354c61" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "#32668f",
  },
  ".cm-panels": { borderColor: "#29374b", backgroundColor: "#121d2b" },
}, { dark: true });
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "#8c9db0" },
  { tag: [tags.keyword, tags.modifier], color: "#c8adf7" },
  { tag: [tags.string, tags.regexp], color: "#9bd8b0" },
  { tag: [tags.number, tags.bool, tags.null], color: "#f2bd88" },
  { tag: [tags.typeName, tags.tagName, tags.propertyName], color: "#87d6e8" },
  { tag: [tags.heading, tags.strong], color: "#86e5cd", fontWeight: "bold" },
  { tag: tags.link, color: "#91c5ff", textDecoration: "underline" },
  { tag: tags.invalid, color: "#ff9f9f" },
]));
const errorText = (error) =>
  error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");

const api = window.editorApi;
const root = document.querySelector("#remote-editor");
function el(tag, cls, label) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (label) node.textContent = label;
  return node;
}

const top = el("header", "editor-top");
const name = el("strong", "editor-name");
const modified = el("span", "editor-modified", "●");
modified.hidden = true;
modified.title = "有未保存的修改";
const saveButton = el("button", "editor-save", "保存");
saveButton.title = "保存到远端 (Ctrl+S)";
top.append(name, modified, saveButton);
const breadcrumb = el("div", "editor-path");
const body = el("div", "editor-body");
const surface = el("div", "editor-surface");
const map = el("aside", "editor-map");
map.hidden = true;
const canvas = el("canvas");
const viewport = el("button", "editor-map-viewport");
viewport.title = "跳转到代码位置";
viewport.setAttribute("aria-label", "代码缩略图，使用方向键滚动");
map.append(canvas, viewport);
body.append(surface, map);
const footer = el("footer", "editor-status");
const message = el("span", "editor-message", "正在打开…");
message.setAttribute("role", "status");
function setMessage(text) {
  message.textContent = text;
  message.title = text;
}
const position = el("span");
const charset = el("select", "editor-charset");
charset.setAttribute("aria-label", "文件编码");
const currentEncoding = new Option("编码", "");
charset.append(currentEncoding);
for (const [action, label] of [["open", "按编码重新读取"], ["save", "用编码保存"]]) {
  const group = el("optgroup");
  group.label = label;
  for (const [value, text] of [["utf-8", "UTF-8"], ["gbk", "GBK / CP936"]])
    group.append(new Option(text, action + ":" + value));
  charset.append(group);
}
const mode = el("span");
footer.append(message, position, charset, mode);
root.append(top, breadcrumb, body, footer);

let view, saved, encoding, eol, busy = false, dirty = false;
const inputLock = new Compartment();
let mapFrame, mapDirty = true, mapDoc;
let language = "纯文本", syntax = [];
function updateControls() {
  saveButton.disabled = !view || !dirty || busy;
  charset.disabled = !view || busy;
  if (!view) return;
  currentEncoding.textContent = encoding.toUpperCase();
  charset.value = "";
  const cursor = view.state.selection.main.head;
  const line = view.state.doc.lineAt(cursor);
  position.textContent = `行 ${line.number}，列 ${cursor - line.from + 1}`;
  mode.textContent = `${{ "\r\n": "CRLF", "\r": "CR", "\n": "LF" }[eol]}  ·  ${language}`;
}
function setDirty(next) {
  if (next === dirty) return;
  dirty = next;
  modified.hidden = !dirty;
  api.dirty(dirty);
}

function updateMinimap(contentChanged = false) {
  mapDirty ||= contentChanged;
  if (mapFrame) return;
  mapFrame = requestAnimationFrame(() => {
    mapFrame = null;
    if (!view) return;
    const doc = view.state.doc;
    map.hidden = doc.lines < 18;
    if (map.hidden) return;
    const height = map.clientHeight;
    const width = map.clientWidth;
    if (!height || !width) return;
    if (mapDirty || mapDoc !== doc || canvas.height !== height || canvas.width !== width) {
      mapDirty = false;
      mapDoc = doc;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      const step = Math.max(1, Math.ceil(doc.lines / Math.min(260, Math.max(1, height / 2))));
      for (let n = 1; n <= doc.lines; n += step) {
        const line = doc.line(n);
        const text = doc.sliceString(line.from, Math.min(line.to, line.from + 95));
        const y = 2 + (n - 1) / doc.lines * (height - 4);
        for (const match of text.matchAll(/\/\/.*|#[^ ]*|'[^']*'|"[^"]*"|\b\d+\b|[\w\u0080-\uFFFF]+|[^\s\w]/g)) {
          const token = match[0];
          ctx.fillStyle = /^\/\/|^#/.test(token) ? "#5c738b" :
            /^['"]/.test(token) ? "#73ae91" :
            /^\d/.test(token) ? "#cb9a6e" : "#8a9eb1";
          ctx.fillRect(3 + match.index, y, Math.max(1, token.length - 0.6), 1);
        }
      }
    }
    const scroll = view.scrollDOM;
    const visible = Math.min(height, Math.max(10, height * scroll.clientHeight / scroll.scrollHeight));
    const offset = scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight);
    viewport.style.height = visible + "px";
    viewport.style.top = (height - visible) * offset + "px";
  });
}
map.addEventListener("pointerdown", (event) => {
  if (!view || event.button !== 0) return;
  map.setPointerCapture(event.pointerId);
  seek(event);
});
map.addEventListener("pointermove", (event) => {
  if (map.hasPointerCapture(event.pointerId)) seek(event);
});
function seek(event) {
  const bounds = map.getBoundingClientRect();
  const scroll = view.scrollDOM;
  scroll.scrollTop =
    (event.clientY - bounds.top) / bounds.height * scroll.scrollHeight -
    scroll.clientHeight / 2;
}
viewport.onkeydown = (event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  view.scrollDOM.scrollTop += view.scrollDOM.clientHeight * (event.key === "ArrowUp" ? -0.5 : 0.5);
};
new ResizeObserver(() => updateMinimap(true)).observe(body);

function load(data) {
  encoding = data.encoding;
  eol = data.eol;
  const state = EditorState.create({
    doc: data.text,
    extensions: [
      basicSetup, theme, highlighting, syntax, inputLock.of([]),
      keymap.of([indentWithTab]),
      Prec.highest(keymap.of([{ key: "Mod-s", run: () => { save(); return true; } }])),
      EditorView.contentAttributes.of({ "aria-label": "文件内容" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setDirty(!update.state.doc.eq(saved));
        if (update.docChanged || update.selectionSet) updateControls();
        if (update.docChanged || update.geometryChanged || update.viewportChanged)
          updateMinimap(update.docChanged);
      }),
    ],
  });
  saved = state.doc;
  if (view) view.setState(state);
  else {
    view = new EditorView({ state, parent: surface });
    view.scrollDOM.addEventListener("scroll", () => updateMinimap(), { passive: true });
  }
  setDirty(false);
  updateControls();
  updateMinimap(true);
  view.focus();
}

async function save(choice = encoding, convert = false) {
  if (!view || busy || (!dirty && (!convert || choice === encoding))) return;
  const snapshot = view.state.doc;
  busy = true;
  setMessage("正在保存到远端…");
  updateControls();
  try {
    await api.save({ text: snapshot.toString(), encoding: choice });
    encoding = choice;
    saved = snapshot;
    setDirty(!view.state.doc.eq(saved));
    setMessage("已保存到远端");
  } catch (error) {
    setMessage("保存失败：" + errorText(error));
  } finally {
    busy = false;
    updateControls();
  }
}

saveButton.onclick = () => save();
charset.onchange = async () => {
  const [action, choice] = charset.value.split(":");
  charset.value = "";
  if (!choice || busy) return;
  if (action === "save") {
    await save(choice, true);
    return;
  }
  if (dirty && !window.confirm("重新读取会丢弃当前未保存的修改。继续？")) return;
  busy = true;
  // Prevent edits made during the reload from being overwritten on completion.
  view.dispatch({ effects: inputLock.reconfigure([
    EditorState.readOnly.of(true), EditorView.editable.of(false),
  ]) });
  setMessage("正在重新读取…");
  updateControls();
  try {
    load(await api.reload(choice));
    setMessage("已按 " + choice.toUpperCase() + " 重新读取");
  } catch (error) {
    setMessage("重新读取失败：" + errorText(error));
  } finally {
    view.dispatch({ effects: inputLock.reconfigure([]) });
    busy = false;
    updateControls();
  }
};

updateControls();
try {
  const data = await api.initialize();
  [language, syntax] = await languageFor(data.name);
  name.textContent = data.name;
  breadcrumb.textContent = [data.server, ...data.path.split("/").filter(Boolean)].join("  ›  ");
  breadcrumb.title = data.path;
  load(data);
  setMessage("远程文件");
} catch (error) {
  setMessage("打开失败：" + errorText(error));
}
