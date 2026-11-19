import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "./style.css";
const $ = (s) => document.querySelector(s);
const api = window.api;
let sessions = [],
  current = null,
  pendingDelete = null,
  passwordResolve;
let editorVersion = 0;
const tabs = new Map();
const groups = [];
let groupMenuId = 0;
const terminalDragType = "application/x-jayxterm-terminal";
const remoteDragType = "application/x-jayxterm-sftp";
let focusedGroup;
let fileWorkspaceOpen = false;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 6000);
}
async function openRemoteEditor(t, file) {
  if (t.state !== "已连接" || t.moving) {
    toast("请先连接 SSH");
    return;
  }
  try {
    await api.openRemoteEditor({ id: t.id, path: remoteJoin(t.path, file.name) });
  } catch (error) {
    toast("打开文件失败：" + error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
  }
}
function setMode(mode) {
  const files = mode === "files";
  $("#session-panel").classList.toggle("hidden", files);
  $("#files-panel").classList.toggle("hidden", !files);
  $("#mode-sessions").classList.toggle("active", !files);
  $("#mode-files").classList.toggle("active", files);
  const t = tabs.get(current);
  if (files && !t)
    $("#file-list").replaceChildren(
      el("div", "empty", "请先在会话中连接一台服务器。"),
    );
}
$("#mode-sessions").onclick = () => setMode("sessions");
$("#mode-files").onclick = () => setMode("files");
function renderSessions() {
  $("#welcome-new").textContent = sessions.length
    ? "＋ 新建会话"
    : "＋ 添加第一台服务器";
  const list = $("#sessions");
  list.replaceChildren();
  const q = $("#search").value.toLowerCase();
  const filtered = sessions.filter((s) =>
    [s.name, s.host, s.username, s.group].join(" ").toLowerCase().includes(q),
  );
  if (!filtered.length)
    list.append(
      el(
        "div",
        "empty",
        sessions.length
          ? "没有匹配的会话"
          : "还没有会话。\n添加一台服务器开始工作。",
      ),
    );
  const groups = [...new Set(filtered.map((s) => s.group || "未分组"))].sort();
  for (const group of groups) {
    list.append(el("div", "group-heading", group));
    for (const s of filtered.filter((s) => (s.group || "未分组") === group)) {
      const row = el("div", "session");
      row.tabIndex = 0;
      row.title = "双击连接";
      row.append(el("span", "server-icon", "▤"));
      const info = el("div", "session-info");
      info.append(
        el("strong", "", s.name),
        el("small", "", `${s.username}@${s.host}:${s.port}`),
      );
      row.append(info);
      const tools = el("div", "session-tools");
      for (const [label, title, handler] of [
        ["↗", "连接", () => connect(s)],
        ["✎", "编辑", () => edit(s)],
        [
          "×",
          "删除",
          () => {
            pendingDelete = s.id;
            $("#confirm-dialog").showModal();
          },
        ],
      ]) {
        const b = el("button", "", label);
        b.title = title;
        b.onclick = (e) => {
          e.stopPropagation();
          handler();
        };
        tools.append(b);
      }
      row.append(tools);
      row.ondblclick = () => connect(s);
      row.onkeydown = (e) => {
        if (e.key === "Enter") connect(s);
      };
      list.append(row);
    }
  }
}
function edit(s = {}) {
  const form = $("#session-form");
  form.reset();
  editorVersion++;
  form.elements.password.type = "password";
  $("#toggle-password").textContent = "显示";
  $("#toggle-password").setAttribute("aria-pressed", "false");
  form.elements.encoding.value = s.encoding || "utf-8";
  $("#test-status").textContent = "";
  $("#test-connection").disabled = false;
  for (const field of ["id", "name", "host", "port", "username", "group"])
    form.elements[field].value =
      s[field] ?? (field === "port" ? 22 : field === "username" ? "root" : "");
  form.elements.remember.checked = s.id ? s.hasPassword : true;
  form.elements.password.placeholder = s.hasPassword
    ? "已保存 · 留空保留密码"
    : "输入连接密码";
  $("#editor-title").textContent = s.id ? "编辑会话" : "新建会话";
  $("#form-error").textContent = "";
  $("#editor").showModal();
}
$("#toggle-password").onclick = async () => {
  const form = $("#session-form"),
    field = form.elements.password,
    button = $("#toggle-password");
  if (field.type === "text") {
    field.type = "password";
    button.textContent = "显示";
    button.setAttribute("aria-pressed", "false");
    return;
  }
  const version = editorVersion;
  try {
    if (!field.value && form.elements.id.value) {
      const password = await api.reveal(form.elements.id.value);
      if (version !== editorVersion || !$("#editor").open) return;
      if (!field.value) field.value = password;
    }
    field.type = "text";
    button.textContent = "隐藏";
    button.setAttribute("aria-pressed", "true");
  } catch (e) {
    $("#form-error").textContent = e.message;
  }
};
$("#editor").addEventListener("close", () => {
  editorVersion++;
  $("#session-form").elements.password.value = "";
  $("#session-form").elements.password.type = "password";
});
$("#test-connection").onclick = async () => {
  const form = $("#session-form");
  for (const field of ["host", "port", "username"])
    if (!form.elements[field].reportValidity()) return;
  const version = editorVersion;
  $("#test-connection").disabled = true;
  $("#test-status").textContent = "正在测试 SSH 认证和 SFTP…";
  $("#test-status").className = "";
  try {
    const result = await api.test(Object.fromEntries(new FormData(form)));
    if (version !== editorVersion) return;
    $("#test-status").textContent = result.message;
    $("#test-status").className = result.sftp ? "success" : "warning";
  } catch (e) {
    if (version === editorVersion) {
      $("#test-status").textContent = "连接失败：" + e.message;
      $("#test-status").className = "error";
    }
  } finally {
    if (version === editorVersion) $("#test-connection").disabled = false;
  }
};
$("#encoding-help").onclick = () => {
  $("#help-options").hidePopover();
  $("#encoding-dialog").showModal();
};
$("#cwd-help").onclick = () => {
  $("#help-options").hidePopover();
  showCwdDialog(tabs.get(current));
};
for (const [menuId, buttonId, opensUp] of [
  ["#upload-options", "#upload", false],
  ["#help-options", "#help-menu", true],
]) {
  const menu = $(menuId);
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    const bounds = $(buttonId).getBoundingClientRect();
    menu.style.left = opensUp ? "auto" : `${bounds.left}px`;
    menu.style.right = opensUp ? `${innerWidth - bounds.right}px` : "auto";
    menu.style.top = opensUp ? "auto" : `${bounds.bottom + 5}px`;
    menu.style.bottom = opensUp ? `${innerHeight - bounds.top + 5}px` : "auto";
  });
}
$("#encoding-close").onclick = () => $("#encoding-dialog").close();
$("#terminal-encoding").onchange = async () => {
  const t = tabs.get(current);
  if (!t) return;
  const selector = $("#terminal-encoding");
  const encoding = selector.value;
  selector.disabled = true;
  try {
    await api.encoding({ id: t.id, encoding });
    t.encoding = encoding;
    sessions = await api.sessions();
    renderSessions();
    toast(
      "终端编码已切换为 " +
        encoding.toUpperCase() +
        "；仅影响后续输出，可按 Ctrl+L 重绘。",
    );
  } catch (e) {
    toast(e.message);
  } finally {
    const active = tabs.get(current);
    selector.value = active?.encoding || "utf-8";
    selector.disabled = !active;
  }
};
$("#new").onclick = $("#welcome-new").onclick = () => edit();
$("#editor-cancel").onclick = () => $("#editor").close();
$("#search").oninput = renderSessions;
// Use explicit checkbox state; unchecked fields are absent from FormData.
$("#session-form").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const s = Object.fromEntries(new FormData(form));
    s.remember = form.elements.remember.checked;
    sessions = await api.save(s);
    $("#editor").close();
    renderSessions();
  } catch (err) {
    $("#form-error").textContent = err.message;
  }
};
$("#delete-cancel").onclick = () => $("#confirm-dialog").close();
$("#delete-confirm").onclick = async () => {
  try {
    sessions = await api.remove(pendingDelete);
    renderSessions();
    $("#confirm-dialog").close();
  } catch (e) {
    toast(e.message);
  }
};
$("#password-form").onsubmit = (e) => {
  e.preventDefault();
  const p = $("#connect-password").value;
  $("#password-dialog").close();
  passwordResolve?.(p);
  passwordResolve = null;
  $("#connect-password").value = "";
};
$("#password-dialog").addEventListener("cancel", () => {
  passwordResolve?.(null);
  passwordResolve = null;
});
$("#password-cancel").onclick = () => {
  $("#password-dialog").close();
  passwordResolve?.(null);
  passwordResolve = null;
};
async function connect(session) {
  let password;
  if (!session.hasPassword) {
    $("#password-host").textContent = `${session.username}@${session.host}`;
    $("#connect-password").value = "";
    $("#password-dialog").showModal();
    password = await new Promise((r) => (passwordResolve = r));
    if (password === null) return;
  }
  try {
    const id = await api.connect({
      sessionId: session.id,
      password,
      cols: 100,
      rows: 30,
    });
    createTerminal(session, id);
  } catch (e) {
    toast(e.message);
  }
}
async function terminalClipboard(t, action) {
  if (!t || !tabs.has(t.id) || t.moving) return;
  try {
    if (action === "copy") {
      const text = t.term.getSelection();
      if (text) await api.writeClipboard(text);
    } else if (action === "paste") {
      if (t.state !== "已连接") return;
      const text = await api.readClipboard();
      if (!tabs.has(t.id) || t.moving || t.term.options.disableStdin) return;
      // xterm's paste API honors bracketed-paste mode and normalizes line breaks.
      // It uses the same onData path as typing, including GBK input conversion.
      if (text) {
        t.term.clearSelection();
        t.term.paste(text);
      }
    } else if (action === "select-all") t.term.selectAll();
    t.term.focus();
  } catch (error) {
    toast(error.message);
  }
}
function createTerminal(session, id, { moving = false } = {}) {
  const pane = el("div", "terminal-pane");
  const group = focusedGroup || addGroup();
  group.body.append(pane);
  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: 1.15,
    scrollback: 3000,
    cursorBlink: false,
    theme: {
      background: "#0c111a",
      foreground: "#d7e0ed",
      cursor: "#78e0bd",
      selectionBackground: "#345470",
      black: "#182330",
      red: "#ed8291",
      green: "#7cdbad",
      yellow: "#e5ce8b",
      blue: "#85b9ee",
      magenta: "#b9a0e8",
      cyan: "#7dd8dd",
      white: "#d7e0ed",
    },
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  const tab = {
    moving,
    group,
    id,
    session,
    term,
    fit,
    pane,
    state: "连接中",
    encoding: session.encoding || "utf-8",
    path: ".",
    files: [],
    loadVersion: 0,
  };
  term.parser.registerOscHandler(7, (value) => {
    const match = /^file:\/\/([^/]*)(\/[^\x00-\x1f]*)$/.exec(value);
    if (!match) return true;
    const [, host, path] = match;
    try {
      const decoded = decodeURIComponent(path);
      if (decoded.includes("\0")) return true;
      if (host.startsWith("jayxterm-query-")) {
        if (tab.cwdQuery?.host === host) {
          clearCwdQuery(tab);
          loadFiles(tab, decoded);
        }
      } else {
        tab.shellDirectory = decoded;
      }
    } catch {
      // A malformed URI should not replace the last known directory.
    }
    return true;
  });
  tabs.set(id, tab);
  pane.addEventListener("focusin", () => {
    if (current !== id && !fileWorkspaceOpen && tab.group.shown === id)
      activate(id, false);
  });
  // Clipboard operations are available only through the terminal context menu.
  // Keep ordinary terminal keys (Ctrl+C, Vim Ctrl+V, etc.) untouched.
  const blockBrowserClipboard = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  pane.addEventListener("copy", blockBrowserClipboard, true);
  pane.addEventListener("paste", blockBrowserClipboard, true);
  pane.oncontextmenu = (event) => {
    event.preventDefault();
    api
      .clipboardMenu({
        id,
        hasSelection: term.hasSelection(),
        canPaste: tab.state === "已连接" && !tab.moving,
      })
      .catch((error) => toast(error.message));
  };
  term.onData((data) => {
    if (!tab.moving) api.send({ type: "input", id, data });
  });
  term.onResize(
    ({ cols, rows }) =>
      !tab.moving && api.send({ type: "resize", id, cols, rows }),
  );
  if (!moving) {
    activate(id);
    setMode("files");
    term.writeln("\x1b[38;2;114;205;177m正在连接 " + session.host + "…\x1b[0m");
  }
  return tab;
}
function addGroup() {
  if (groups.length >= 4) return null;
  const root = el("section", "terminal-group");
  const heading = el("header", "terminal-group-heading");
  const nav = el("nav", "tabs");
  const menuButton = el("button", "group-menu-button", "⋯");
  const menu = el("div", "action-popover group-menu");
  menu.id = "split-menu-" + ++groupMenuId;
  menu.setAttribute("popover", "");
  menu.setAttribute("aria-label", "分屏操作");
  menuButton.type = "button";
  menuButton.title = "分屏操作";
  menuButton.setAttribute("aria-label", "分屏操作");
  menuButton.setAttribute("popovertarget", menu.id);
  heading.append(nav, menuButton, menu);
  const body = el("div", "terminal-group-body");
  const empty = el("button", "group-empty", "拖入终端标签，或点击后连接会话");
  body.append(empty);
  root.append(heading, body);
  $("#terminal-area").append(root);
  terminalResize.observe(body);
  const group = { root, body, nav, menuButton, empty, shown: null };
  groups.push(group);
  const focusGroup = () => {
    focusedGroup = group;
    activate(group.shown);
    if (!group.shown) setMode("sessions");
  };
  empty.onclick = focusGroup;
  heading.addEventListener("click", (event) => {
    if (event.target === nav || event.target === heading) focusGroup();
  });
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    const bounds = menuButton.getBoundingClientRect();
    menu.style.top = bounds.bottom + 4 + "px";
    menu.style.right = innerWidth - bounds.right + "px";
    menu.replaceChildren();
    for (const [index, target] of groups.entries()) {
      if (target === group) continue;
      const item = el("button", "", `合并到分屏 ${index + 1}`);
      item.type = "button";
      item.onclick = () => {
        menu.hidePopover();
        mergeGroup(group, target);
      };
      menu.append(item);
    }
  });
  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes(terminalDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    root.classList.add("split-drop");
  });
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget))
      root.classList.remove("split-drop");
  });
  root.addEventListener("drop", (event) => {
    const id = event.dataTransfer.getData(terminalDragType);
    root.classList.remove("split-drop");
    const tab = tabs.get(id);
    if (!tab || tab.moving) return;
    event.preventDefault();
    moveToGroup(tab, group);
    activate(id);
  });
  return group;
}
function nextInGroup(group) {
  return [...tabs.values()].find((tab) => tab.group === group)?.id || null;
}
function moveToGroup(tab, group) {
  const previous = tab.group;
  if (previous === group) return;
  tab.group = group;
  group.body.append(tab.pane);
  if (previous.shown === tab.id) {
    previous.shown = nextInGroup(previous);
    const replacement = tabs.get(previous.shown);
    if (replacement) requestAnimationFrame(() => fitTerminal(replacement));
  }
}
function mergeGroup(group, target) {
  if (!groups.includes(target)) return;
  const incoming = [...tabs.values()].filter((tab) => tab.group === group);
  if (incoming.some((tab) => tab.moving)) {
    toast("请等会话移动完成后再合并分屏");
    return;
  }
  const shown = group.shown;
  for (const tab of incoming) moveToGroup(tab, target);
  if (!target.shown) target.shown = shown || nextInGroup(target);
  groups.splice(groups.indexOf(group), 1);
  terminalResize.unobserve(group.body);
  group.root.remove();
  if (focusedGroup === group) focusedGroup = target;
  activate(current || target.shown || nextInGroup(target));
}
function syncGroups() {
  $("#terminal-area").dataset.count = groups.length;
  $("#split-add").disabled =
    !tabs.size || groups.length >= 4;
  $("#file-workspace-toggle").disabled = !tabs.size && !fileWorkspaceOpen;
  for (const [index, group] of groups.entries()) {
    group.root.classList.toggle("focused", group === focusedGroup);
    group.nav.setAttribute("aria-label", `分屏 ${index + 1} 的终端标签`);
    group.menuButton.hidden = groups.length === 1;
    group.empty.classList.toggle("hidden", !!group.shown || fileWorkspaceOpen);
    if (fileWorkspaceOpen) {
      group.filePanel ??= createWorkspacePanel(group);
      renderWorkspaceFiles(group);
    }
  }
  for (const tab of tabs.values())
    tab.pane.classList.toggle("active", tab.group.shown === tab.id);
}
$("#split-add").onclick = () => {
  if (!tabs.size) return;
  addGroup();
  activate(current, false);
};
function createTabElement(tab) {
  const element = el("div", "tab");
  const select = el("button", "tab-select");
  const label = el("span", "tab-name", tab.session.name);
  const close = el("button", "close", "×");
  select.type = close.type = "button";
  select.append(el("span", "dot"), label);
  close.title = "关闭连接";
  close.setAttribute("aria-label", "关闭 " + tab.session.name);
  close.onclick = (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  };
  element.append(select, close);
  element.onclick = () => activate(tab.id);
  element.oncontextmenu = (event) => {
    event.preventDefault();
    api.tabMenu(tab.id);
  };
  element.onkeydown = (event) => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      api.tabMenu(tab.id);
    }
  };
  element.dataset.connection = tab.id;
  element.title = tab.session.name + " · 可拖到其他分屏";
  element.ondragstart = (event) => {
    if (tab.moving || event.target.closest(".close")) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(terminalDragType, tab.id);
    event.dataTransfer.effectAllowed = "move";
  };
  return { element, select };
}
function renderTabs() {
  for (const tab of tabs.values()) {
    tab.header ??= createTabElement(tab);
    const { element, select } = tab.header;
    if (element.parentElement !== tab.group.nav) tab.group.nav.append(element);
    const visible = tab.group.shown === tab.id;
    element.classList.toggle("active", visible);
    select.setAttribute("aria-pressed", String(visible));
    element.draggable = !tab.moving;
  }
}
function fitTerminal(t) {
  if (
    t.moving ||
    !tabs.has(t.id) ||
    fileWorkspaceOpen ||
    t.group.shown !== t.id
  )
    return;
  t.fit.fit();
  t.pane.dataset.cols = t.term.cols;
  t.pane.dataset.rows = t.term.rows;
  // fit() emits nothing when the geometry is unchanged. Always resync a ready
  // shell, including the first fit that happened before SSH finished opening.
  if (t.state === "已连接")
    api.send({
      type: "resize",
      id: t.id,
      cols: t.term.cols,
      rows: t.term.rows,
    });
}
function activate(id, focus = true) {
  current = id;
  const t = tabs.get(id);
  if (t) {
    focusedGroup = t.group;
    t.group.shown = id;
  }
  syncGroups();
  api.windowTitle(t?.session.name || "工作空间");
  $("#focused-sftp").textContent = t ? t.session.name : "SFTP";
  $("#move-tab").disabled = !t || t.moving || t.state !== "已连接";
  $("#terminal-encoding").disabled = !t;
  $("#terminal-encoding").value = t?.encoding || "utf-8";
  $("#welcome").classList.toggle("hidden", tabs.size > 0 || fileWorkspaceOpen);
  $("#connected").classList.toggle("hidden", !tabs.size && !fileWorkspaceOpen);
  $("#workspace-title").textContent = t ? t.session.name : "概览";
  $("#welcome-new").textContent = sessions.length
    ? "＋ 新建会话"
    : "＋ 添加第一台服务器";
  renderTabs();
  if (t) {
    if (!fileWorkspaceOpen)
      requestAnimationFrame(() => {
        if (current !== t.id || fileWorkspaceOpen) return;
        fitTerminal(t);
        if (focus) t.term.focus();
      });
    $("#status").textContent =
      `${t.session.username}@${t.session.host} · ${t.state}`;
    $("#remote-path").value = t.path;
    renderSidebarFiles(t);
  } else {
    $("#status").textContent = "就绪";
    $("#file-list").replaceChildren(el("div", "empty", "请先连接一台服务器。"));
    $("#remote-path").value = "";
    setMode("sessions");
  }
}
function closeTab(id, disconnect = true) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.moving && disconnect) {
    toast("会话正在移动，请稍后关闭");
    return;
  }
  if (disconnect) api.send({ type: "disconnect", id });
  clearCwdQuery(t);
  t.term.dispose();
  t.pane.remove();
  t.header?.element.remove();
  tabs.delete(id);
  if (t.group.shown === id) {
    t.group.shown = nextInGroup(t.group);
    const replacement = tabs.get(t.group.shown);
    if (replacement) requestAnimationFrame(() => fitTerminal(replacement));
  }
  if (current === id)
    activate(
      t.group.shown || groups.find((group) => group.shown)?.shown || null,
    );
  else {
    syncGroups();
    renderTabs();
  }
  if (!tabs.size && groups.length > 1) {
    for (const group of groups.splice(1)) {
      terminalResize.unobserve(group.body);
      group.root.remove();
    }
    focusedGroup = groups[0];
    syncGroups();
  }
}
let fitFrame;
const terminalResize = new ResizeObserver(() => {
  if (fileWorkspaceOpen || fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    for (const group of groups) {
      const tab = tabs.get(group.shown);
      if (tab) fitTerminal(tab);
    }
  });
});
api.onEvent((m) => {
  const t = tabs.get(m.id);
  if (!t) return;
  if (m.type === "data") {
    const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
    t.term.write(bytes, () =>
      api.send({ type: "ack", id: m.id, bytes: m.bytes }),
    );
  } else if (m.type === "ready") {
    t.state = "已连接";
    fitTerminal(t);
    loadFiles(t, ".");
    if (current === t.id) activate(t.id);
  } else if (m.type === "closed" || m.type === "error") {
    clearCwdQuery(t);
    t.state = m.type === "closed" ? "已断开" : "连接出错";
    if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
    t.term.writeln("\r\n\x1b[31m" + (m.message || "连接已关闭") + "\x1b[0m");
    if (current === t.id)
      $("#status").textContent =
        `${t.session.username}@${t.session.host} · ${t.state}`;
  } else if (m.type === "progress") {
    const text = `${m.files || 0} 个文件完成 · ${m.name?.split("/").pop() || ""} ${m.total ? Math.round((m.current / m.total) * 100) : 0}%`;
    showTransfer(t, text);
  }
});
function size(n) {
  return n < 1024
    ? n + " B"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " KB"
      : (n / 1048576).toFixed(1) + " MB";
}
function remoteJoin(base, name) {
  return (base === "/" ? "" : base) + "/" + name;
}
function renderSidebarFiles(tab) {
  renderFiles(tab, $("#file-list"));
  $("#transfer-status").textContent = tab.transferStatus || "拖入上传 · 双击文件编辑";
}
function renderFiles(t, list) {
  highlightDropTarget(null);
  list.replaceChildren();
  if (!t.files.length)
    list.append(
      el(
        "div",
        "empty",
        t.loading
          ? "正在读取目录…"
          : t.fileError || "目录为空，可将本地文件或文件夹拖到这里上传。",
      ),
    );
  for (const f of t.files) {
    const row = el(
      "div",
      "file-row" + (t.selected?.name === f.name ? " selected" : ""),
    );
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    if (!f.symlink) {
      row.draggable = true;
      row.ondragstart = (event) =>
        startRemoteDrag(event, t.id, remoteJoin(t.path, f.name));
    }
    row.title = f.directory
      ? "双击进入目录；右侧 ↓ 下载整个目录"
      : f.symlink ? "双击下载文件" : "双击编辑；右侧 ↓ 下载文件";
    if (f.directory) row.dataset.directory = remoteJoin(t.path, f.name);
    row.append(
      el("span", "file-icon", f.directory ? "▸" : f.symlink ? "↗" : "▫"),
      el("span", "filename", f.name),
      el("small", "", f.directory ? "目录" : size(f.size)),
    );
    const download = el("button", "download-one", "↓");
    download.title = f.directory ? "下载整个目录" : "下载文件";
    download.onclick = (e) => {
      e.stopPropagation();
      transfer(t, "download", remoteJoin(t.path, f.name), f.directory);
    };
    row.append(download);
    row.onclick = () => {
      t.selected = f;
      for (const item of list.children) item.classList.remove("selected");
      row.classList.add("selected");
    };
    row.ondblclick = (event) => {
      if (event?.target.closest("button")) return;
      if (f.directory) loadFiles(t, remoteJoin(t.path, f.name));
      else if (f.symlink) transfer(t, "download", remoteJoin(t.path, f.name));
      else openRemoteEditor(t, f);
    };
    row.onkeydown = (e) => {
      if (e.key === "Enter" && e.target === row) {
        e.preventDefault();
        row.ondblclick();
      }
    };
    list.append(row);
  }
}
async function loadFiles(t, path) {
  const v = ++t.loadVersion;
  t.loading = true;
  t.fileError = "";
  if (current === t.id) renderSidebarFiles(t);
  if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
  try {
    const data = await api.list({ id: t.id, path });
    if (v !== t.loadVersion || !tabs.has(t.id)) return;
    t.path = data.path;
    t.selected = null;
    t.files = data.files
      .filter((f) => f.name !== "." && f.name !== "..")
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      );
  } catch (e) {
    if (v !== t.loadVersion || !tabs.has(t.id)) return;
    t.fileError = e.message;
    t.files = [];
  } finally {
    if (v === t.loadVersion && tabs.has(t.id)) {
      t.loading = false;
      if (current === t.id) {
        $("#remote-path").value = t.path;
        renderSidebarFiles(t);
      }
      if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
    }
  }
}
function showTransfer(t, message) {
  t.transferStatus = message;
  if (current === t.id) $("#transfer-status").textContent = message;
  if (t.group.filePanel && t.group.shown === t.id)
    t.group.filePanel.status.textContent = message;
}
async function transfer(
  t,
  action,
  path,
  directory = false,
  files = null,
  token = null,
) {
  const tab = tabs.get(t.id);
  if (!tab || tab.transferring) {
    toast("请等待当前传输完成");
    return;
  }
  tab.transferring = true;
  showTransfer(t, "准备传输…");
  try {
    const request = { id: t.id, path };
    const r = token
      ? await api.relay({ ...request, token })
      : files
        ? await api.drop(request, files)
        : await api.transfer({ ...request, action, directory });
    showTransfer(
      t,
      r?.cancelled
        ? "已取消"
        : `完成 ${r?.files || 0} 个文件 · ${size(r?.bytes || 0)}${r?.skipped ? " · 跳过 " + r.skipped + " 项" : ""}`,
    );
    if (!r?.cancelled && (token || files || action.startsWith("upload")))
      loadFiles(t, t.path);
  } catch (error) {
    toast(error.message);
    showTransfer(t, "传输失败：" + error.message);
  } finally {
    tab.transferring = false;
  }
}
const remoteTokenPrefix = "jayxterm-sftp:";
function startRemoteDrag(event, id, path) {
  const tab = tabs.get(id);
  if (
    !tab ||
    tab.moving ||
    tab.transferring ||
    tab.state !== "已连接" ||
    event.target.closest("button")
  ) {
    event.preventDefault();
    return;
  }
  const token = api.remoteDrag({ id, path });
  if (!token) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(remoteDragType, token);
  event.dataTransfer.setData("text/plain", remoteTokenPrefix + token);
}
for (const type of ["dragover", "drop"])
  document.addEventListener(type, (event) => event.preventDefault());
let highlightedDropTarget;
function highlightDropTarget(target) {
  if (target === highlightedDropTarget) return;
  highlightedDropTarget?.classList.remove("drop-active");
  highlightedDropTarget = target;
  target?.classList.add("drop-active");
}
function addFileDropZone(zone, list, getEntry) {
  const targetAt = (element) =>
    element.closest(".file-row[data-directory]") || list;
  function allowed() {
    const tab = getEntry();
    return tab?.state === "已连接" && !tab.moving && !tab.loading && !tab.transferring;
  }
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    const types = event.dataTransfer.types;
    const accepts =
      allowed() &&
      (types.includes("Files") ||
        types.includes(remoteDragType) ||
        types.includes("text/plain"));
    highlightDropTarget(accepts ? targetAt(event.target) : null);
    event.dataTransfer.dropEffect = accepts ? "copy" : "none";
  });
  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) highlightDropTarget(null);
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    highlightDropTarget(null);
    if (!allowed()) return;
    const t = getEntry();
    const to = targetAt(event.target).dataset.directory || t.path;
    const data = event.dataTransfer;
    let token = data.getData(remoteDragType);
    const text = data.getData("text/plain");
    if (!token && text.startsWith(remoteTokenPrefix))
      token = text.slice(remoteTokenPrefix.length);
    const files = Array.from(data.files);
    if (token || files.length)
      transfer(t, "upload", to, false, files, token);
  });
}
addFileDropZone($("#files-panel"), $("#file-list"), () => tabs.get(current));
$("#upload-file").onclick = () => {
  $("#upload-options").hidePopover();
  const t = tabs.get(current);
  if (t) transfer(t, "upload", t.path);
};
$("#upload-directory").onclick = () => {
  $("#upload-options").hidePopover();
  const t = tabs.get(current);
  if (t) transfer(t, "upload-directory", t.path);
};
function clearCwdQuery(tab) {
  clearTimeout(tab.cwdQuery?.timer);
  tab.cwdQuery = null;
}
let cwdDialogTab;
function showCwdDialog(tab) {
  cwdDialogTab = tab;
  $("#cwd-dialog").showModal();
}
function cwdCommand(host) {
  const report = (name) =>
    String.raw`printf '\033]7;file://${name}%s\007' "$(command pwd -P | sed 's/%/%25/g')"`;
  const reporter = "__jayxterm_report_cwd() { " +
    '[ "${__jayxterm_last_cwd-}" = "$PWD" ] && return 0; ' +
    '__jayxterm_last_cwd=$PWD; ' +
    String.raw`printf '\033]7;file://jayxterm-shell%s\007' "` +
    '${PWD//\\%/%25}"; };';
  const bash = [
    reporter,
    "if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then",
    "PROMPT_COMMAND+=(__jayxterm_report_cwd);",
    'elif [[ -n "${PROMPT_COMMAND-}" ]]; then',
    String.raw`PROMPT_COMMAND+=$'\n'__jayxterm_report_cwd;`,
    "else PROMPT_COMMAND=__jayxterm_report_cwd; fi",
  ].join(" ");
  const zsh = reporter + " typeset -ga precmd_functions; precmd_functions+=(__jayxterm_report_cwd)";
  const quote = (script) => "'" + script.replaceAll("'", "'\\''") + "'";
  // Only install a prompt hook in the interactive shell that the user confirmed.
  // Other shells still get the one-shot result and can use their native OSC 7.
  return report(host) + [
    "; case $- in *i*)",
    'if [ -n "${BASH_VERSION-}" ]; then',
    `if ! declare -F __jayxterm_report_cwd >/dev/null; then eval ${quote(bash)}; fi;`,
    'elif [ -n "${ZSH_VERSION-}" ]; then',
    `if ! typeset -f __jayxterm_report_cwd >/dev/null; then eval ${quote(zsh)}; fi;`,
    "fi;; esac",
  ].join(" ");
}
$("#sync-cwd").onclick = () => {
  const t = tabs.get(current);
  if (t?.state !== "已连接" || t.moving) {
    toast("请先连接 SSH");
    return;
  }
  if (t.shellDirectory) loadFiles(t, t.shellDirectory);
  else if (t.cwdQuery) toast("正在等候 Shell 返回目录");
  else showCwdDialog(t);
};
$("#cwd-query").onclick = () => {
  const dialog = $("#cwd-dialog");
  const tab = cwdDialogTab;
  if (tab?.state !== "已连接" || tabs.get(tab.id) !== tab || tab.moving || tab.term.options.disableStdin) {
    dialog.close();
    toast("请先连接 SSH");
    return;
  }
  if (tab.term.buffer.active.type === "alternate") {
    dialog.close();
    toast("请先退出 Vim 等全屏程序，回到 Shell 提示符后再同步");
    return;
  }
  if (tab.cwdQuery) {
    dialog.close();
    toast("正在等候 Shell 返回目录");
    return;
  }
  const host = `jayxterm-query-${crypto.randomUUID()}`;
  tab.cwdQuery = {
    host,
    timer: setTimeout(() => {
      clearCwdQuery(tab);
      if (current === tab.id)
        toast("未收到目录，请回到空白的 Shell 提示符后重试");
    }, 5000),
  };
  dialog.close();
  if (current === tab.id && !fileWorkspaceOpen) tab.term.focus();
  api.send({ type: "input", id: tab.id, data: cwdCommand(host) + "\r" });
};
$("#path-form").onsubmit = (e) => {
  e.preventDefault();
  const t = tabs.get(current);
  if (t) loadFiles(t, $("#remote-path").value);
};
$("#up").onclick = () => {
  const t = tabs.get(current);
  if (t) loadFiles(t, remoteJoin(t.path, ".."));
};
$("#refresh").onclick = () => {
  const t = tabs.get(current);
  if (t) loadFiles(t, t.path);
};
function createWorkspacePanel(group) {
  const root = el("section", "workspace-files");
  root.setAttribute("aria-label", "远程文件");
  const form = el("form", "pathbar");
  const up = el("button", "", "↑");
  up.type = "button";
  up.title = "上一级";
  const input = el("input");
  input.setAttribute("aria-label", "远程目录");
  const go = el("button", "", "↵");
  go.title = "打开目录";
  const refresh = el("button", "", "↻");
  refresh.type = "button";
  refresh.title = "刷新";
  form.append(up, input, go, refresh);
  const list = el("div", "file-list");
  const status = el("div", "transfer-status");
  const empty = el("button", "group-empty hidden");
  empty.type = "button";
  root.append(form, list, status, empty);
  group.body.append(root);

  const tab = () => tabs.get(group.shown);
  const focusGroup = () => {
    if (focusedGroup === group) return;
    focusedGroup = group;
    activate(group.shown, false);
  };
  root.addEventListener("focusin", focusGroup);
  root.addEventListener("pointerdown", focusGroup);
  empty.onclick = () => {
    focusGroup();
    if (!tab()) setMode("sessions");
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const t = tab();
    if (t) loadFiles(t, input.value);
  };
  up.onclick = () => {
    const t = tab();
    if (t) loadFiles(t, remoteJoin(t.path, ".."));
  };
  refresh.onclick = () => {
    const t = tab();
    if (t) loadFiles(t, t.path);
  };
  addFileDropZone(root, list, tab);
  return { form, input, list, status, empty };
}
function renderWorkspaceFiles(group) {
  const panel = group.filePanel;
  if (!panel) return;
  const tab = tabs.get(group.shown);
  const ready = tab?.state === "已连接" && !tab.moving;
  const previous = panel.rendered;
  const state = { tab, ready, path: tab?.path, files: tab?.files, loading: tab?.loading, status: tab?.state };
  if (previous && Object.keys(state).every((key) => state[key] === previous[key])) return;
  panel.rendered = state;
  panel.form.classList.toggle("hidden", !ready);
  panel.list.classList.toggle("hidden", !ready);
  panel.status.classList.toggle("hidden", !ready);
  panel.empty.classList.toggle("hidden", ready);
  panel.empty.textContent = tab?.moving
    ? "会话正在移动…"
    : tab?.state || "拖入终端标签，或在左侧连接会话";
  if (!ready) {
    panel.list.replaceChildren();
    return;
  }
  if (previous?.tab !== tab || previous.path !== tab.path || tab.loading)
    panel.input.value = tab.path;
  panel.status.textContent = tab.transferStatus || "拖到其他分屏或窗口即可复制";
  renderFiles(tab, panel.list);
}
$("#file-workspace-toggle").onclick = () => {
  fileWorkspaceOpen = !fileWorkspaceOpen;
  $("#terminal-area").classList.toggle("show-file-space", fileWorkspaceOpen);
  const button = $("#file-workspace-toggle");
  button.textContent = fileWorkspaceOpen ? "返回终端" : "文件空间";
  button.setAttribute("aria-pressed", String(fileWorkspaceOpen));
  highlightDropTarget(null);
  activate(current, !fileWorkspaceOpen);
  if (!fileWorkspaceOpen)
    requestAnimationFrame(() => {
      for (const group of groups) {
        const tab = tabs.get(group.shown);
        if (tab && tab.id !== current) fitTerminal(tab);
      }
    });
};
function markMoving(t, moving) {
  t.moving = moving;
  t.term.options.disableStdin = moving;
  t.pane.classList.toggle("moving", moving);
  if (fileWorkspaceOpen) renderWorkspaceFiles(t.group);
  if (current === t.id)
    $("#move-tab").disabled = moving || t.state !== "已连接";
}
api.onWindow(async (m) => {
  if (m.type === "remote-text-saved") {
    const tab = tabs.get(m.id);
    if (tab && tab.path === m.directory) loadFiles(tab, tab.path);
    return;
  }
  if (m.type === "clipboard") {
    await terminalClipboard(tabs.get(m.id), m.action);
    return;
  }
  if (m.type === "sessions-changed") {
    sessions = await api.sessions();
    renderSessions();
    return;
  }
  if (m.type === "notice") {
    toast(m.message);
    return;
  }
  if (m.type === "settled") {
    const t = tabs.get(m.id);
    if (t) {
      markMoving(t, false);
      loadFiles(t, t.path);
    }
    return;
  }
  if (m.type !== "request") return;
  const { id } = m.payload;
  let result;
  try {
    if (m.action === "prepare") {
      const t = tabs.get(id);
      if (
        !t ||
        t.transferring ||
        t.loading ||
        t.cwdQuery ||
        t.state !== "已连接"
      )
        throw new Error("当前会话暂时无法移动");
      markMoving(t, true);
      // Drain received terminal output before the one-off snapshot. Never poll buffers.
      await new Promise((resolve) => t.term.write("", resolve));
      const { SerializeAddon } = await import("@xterm/addon-serialize");
      const serializer = new SerializeAddon();
      t.term.loadAddon(serializer);
      try {
        result = {
          session: t.session,
          encoding: t.encoding,
          path: t.path,
          shellDirectory: t.shellDirectory,
          cols: t.term.cols,
          rows: t.term.rows,
          distanceFromBottom:
            t.term.buffer.active.baseY - t.term.buffer.active.viewportY,
          screen: serializer.serialize({ scrollback: 3000 }),
        };
      } finally {
        serializer.dispose();
      }
    } else if (m.action === "restore") {
      if (tabs.has(id)) throw new Error("目标窗口已有该连接");
      const t = createTerminal(m.payload.session, id, { moving: true });
      t.encoding = m.payload.encoding;
      t.path = m.payload.path;
      t.shellDirectory = m.payload.shellDirectory;
      t.state = "已连接";
      t.term.resize(m.payload.cols, m.payload.rows);
      await new Promise((resolve) => t.term.write(m.payload.screen, resolve));
      t.restoreDistance = m.payload.distanceFromBottom;
    } else if (m.action === "commit") {
      const t = tabs.get(id);
      if (!t) throw new Error("目标标签已关闭");
      markMoving(t, false);
      t.term.options.disableStdin = true;
      t.pane.classList.add("moving");
      activate(id);
      setMode("files");
      fitTerminal(t);
      t.term.scrollToLine(
        Math.max(0, t.term.buffer.active.baseY - (t.restoreDistance || 0)),
      );
      delete t.restoreDistance;
    } else if (m.action === "release" || m.action === "discard") {
      closeTab(id, false);
    } else if (m.action === "rollback") {
      const t = tabs.get(id);
      if (t) {
        markMoving(t, false);
        if (current === id) activate(id);
      }
    }
    api.windowReply({ token: m.token, result });
  } catch (error) {
    api.windowReply({ token: m.token, error: error.message });
  }
});
$("#new-window").onclick = () => api.newWindow();
$("#move-tab").onclick = async () => {
  if (current)
    try {
      await api.moveTab({ id: current });
    } catch (e) {
      toast(e.message);
    }
};
$("#window-picker").onclick = async () => {
  const list = $("#window-list");
  list.replaceChildren();
  const windows = await api.windows();
  for (const w of windows) {
    const row = el("div", "window-row");
    row.append(el("span", "", w.title + " · " + w.count + " 个连接"));
    const focus = el("button", "", "切换");
    focus.onclick = () => {
      api.focusWindow(w.id);
      $("#windows-dialog").close();
    };
    row.append(focus);
    if (w.id !== windowId && current) {
      const move = el("button", "", "移到此窗口");
      move.onclick = async () => {
        const id = current;
        $("#windows-dialog").close();
        try {
          await api.moveTab({ id, target: w.id });
        } catch (e) {
          toast(e.message);
        }
      };
      row.append(move);
    }
    list.append(row);
  }
  $("#windows-dialog").showModal();
};
$("#windows-close").onclick = () => $("#windows-dialog").close();
document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey &&
    (e.code === "PageDown" || e.code === "PageUp") &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    const ids = [...tabs.values()]
      .filter((tab) => tab.group === focusedGroup)
      .map((tab) => tab.id);
    if (ids.length) {
      const next =
        (ids.indexOf(current) + (e.code === "PageDown" ? 1 : -1) + ids.length) %
        ids.length;
      activate(ids[next]);
    }
  } else if (e.ctrlKey && e.shiftKey && e.code === "KeyN") {
    e.preventDefault();
    api.newWindow();
  } else if (e.ctrlKey && e.shiftKey && e.code === "KeyO") {
    e.preventDefault();
    $("#window-picker").click();
  }
});
const { id: windowId, number: windowNumber } = await api.windowReady();
$("#window-label").textContent = "窗口 " + windowNumber;
try {
  sessions = await api.sessions();
  renderSessions();
} catch (e) {
  toast(e.message);
}
