import { defaultShortcuts, formatShortcut, shortcutCommands, shortcutConflict, shortcutFromEvent } from "./shortcuts.mjs";

export function installShortcutSettings(panel) {
  const list = panel.querySelector("#settings-shortcut-list");
  const status = panel.querySelector("#settings-shortcut-status");
  const rows = new Map();
  let original = defaultShortcuts;
  let draft = { ...original };
  let recording = null;

  function render() {
    for (const [id, { record, clear }] of rows) {
      const active = recording === id;
      const value = formatShortcut(draft[id]);
      record.textContent = active ? "按下快捷键…" : value || "未设置";
      record.setAttribute("aria-pressed", String(active));
      record.setAttribute("aria-label", `${shortcutCommands[id].label}的快捷键，${record.textContent}`);
      clear.disabled = !value;
    }
  }
  function stopRecording() {
    recording = null;
    status.textContent = "";
    render();
  }

  for (const [id, { label }] of Object.entries(shortcutCommands)) {
    const row = document.createElement("div");
    row.className = "settings-shortcut-row";
    row.dataset.shortcut = id;
    const name = document.createElement("span");
    name.textContent = label;
    const record = document.createElement("button");
    record.type = "button";
    record.className = "settings-shortcut-record";
    record.onclick = () => {
      recording = recording === id ? null : id;
      status.textContent = "";
      render();
      if (recording === id) record.focus();
    };
    record.onblur = () => { if (recording === id) stopRecording(); };
    record.onkeydown = (event) => {
      if (recording !== id) return;
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        stopRecording();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        stopRecording();
        return;
      }
      if (event.repeat || ["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
      const binding = shortcutFromEvent(event);
      if (!binding) {
        status.textContent = "请按带 Ctrl、Alt 或 Meta 的组合键，或使用功能键。";
        return;
      }
      const conflict = shortcutConflict(draft, id, binding);
      if (conflict) {
        status.textContent = `此快捷键已用于「${shortcutCommands[conflict].label}」。`;
        return;
      }
      draft[id] = binding;
      stopRecording();
    };
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "settings-shortcut-clear";
    clear.textContent = "清空";
    clear.setAttribute("aria-label", `清空${label}的快捷键`);
    clear.onclick = () => {
      draft[id] = "";
      stopRecording();
      record.focus();
    };
    rows.set(id, { record, clear });
    row.append(name, record, clear);
    list.append(row);
  }
  panel.querySelector("#settings-default-shortcuts").onclick = () => {
    draft = { ...defaultShortcuts };
    stopRecording();
  };
  render();
  return {
    load(bindings) {
      original = bindings;
      draft = { ...bindings };
      stopRecording();
    },
    changes() {
      return Object.fromEntries(Object.entries(draft).filter(([id, binding]) => binding !== original[id]));
    },
  };
}
