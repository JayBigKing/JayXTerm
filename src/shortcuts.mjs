export const shortcutCommands = {
  openLocalTerminal: { label: "打开本地终端", binding: "Ctrl+Shift+KeyT" },
  newWindow: { label: "新窗口", binding: "Ctrl+Shift+KeyN" },
  switchWindow: { label: "切换窗口", binding: "Ctrl+Shift+KeyO" },
  previousTab: { label: "上一个终端标签", binding: "Ctrl+PageUp" },
  nextTab: { label: "下一个终端标签", binding: "Ctrl+PageDown" },
};

const modifiers = [["Ctrl", "ctrlKey"], ["Alt", "altKey"], ["Shift", "shiftKey"], ["Meta", "metaKey"]];
const functionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const bindingPattern = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Page(?:Up|Down)|Arrow(?:Up|Down|Left|Right)|Home|End|Insert|Delete|Backspace|Enter|Tab|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;
const symbols = { Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/" };

export const defaultShortcuts = Object.fromEntries(Object.entries(shortcutCommands).map(([id, command]) => [id, command.binding]));

function validShortcut(binding) {
  if (binding === "") return true;
  if (typeof binding !== "string") return false;
  const match = bindingPattern.exec(binding);
  return !!match && (Boolean(match[1] || match[2] || match[4]) || functionKey.test(match[5]));
}

export function shortcutFromEvent(event) {
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !functionKey.test(event.code)) return "";
  if (event.isComposing || event.key === "Dead" || event.getModifierState?.("AltGraph")) return "";
  const binding = [...modifiers.filter(([, field]) => event[field]).map(([name]) => name), event.code].join("+");
  return validShortcut(binding) ? binding : "";
}

export function formatShortcut(binding, accessible = false) {
  if (!binding) return "";
  return binding.split("+").map(key => {
    if (accessible && key === "Ctrl") return "Control";
    return symbols[key] || key.replace(/^(Key|Digit)/, "");
  }).join("+");
}

export function shortcutConflict(bindings, id, binding) {
  return binding ? Object.keys(shortcutCommands).find(other => other !== id && bindings[other] === binding) : undefined;
}

export function readShortcuts(stored) {
  const used = new Set();
  return Object.fromEntries(Object.entries(defaultShortcuts).map(([id, fallback]) => {
    const value = stored?.[id];
    const binding = validShortcut(value) ? value : fallback;
    if (!binding || used.has(binding)) return [id, ""];
    used.add(binding);
    return [id, binding];
  }));
}

export function updateShortcuts(current, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
      Object.entries(changes).some(([id, binding]) => !Object.hasOwn(shortcutCommands, id) || !validShortcut(binding)))
    throw new Error("无效的快捷键设置");
  const next = { ...current, ...changes };
  for (const [id, binding] of Object.entries(next)) {
    const conflict = shortcutConflict(next, id, binding);
    if (conflict) throw new Error(`快捷键冲突：「${shortcutCommands[id].label}」和「${shortcutCommands[conflict].label}」使用了相同组合`);
  }
  return next;
}
