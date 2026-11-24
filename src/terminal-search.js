import { SearchAddon } from "@xterm/addon-search";

export function installTerminalSearch({ getActiveTab, showTerminal, getTheme }) {
  const $ = selector => document.querySelector(selector);
  const panel = $("#terminal-search"), input = $("#terminal-search-input");
  const toggle = $("#terminal-search-toggle"), count = $("#terminal-search-count");
  const previous = $("#terminal-search-previous"), next = $("#terminal-search-next");
  let enabled = false, active, addon, listener, timer;
  function results({ resultIndex = -1, resultCount = 0 } = {}) {
    count.textContent = resultIndex < 0 && resultCount >= 1000 ? "1000+" :
      `${Math.max(0, resultIndex + 1)} / ${resultCount}`;
    previous.disabled = next.disabled = resultCount === 0;
  }
  function options(incremental) {
    const theme = getTheme();
    return {
      incremental, caseSensitive: $("#terminal-search-case").getAttribute("aria-pressed") === "true",
      decorations: {
        matchBackground: theme.surface, matchBorder: theme.variables.warning,
        matchOverviewRuler: theme.variables.warning,
        activeMatchBackground: theme.selection, activeMatchBorder: theme.variables.warning,
        activeMatchColorOverviewRuler: theme.variables.warning,
      },
    };
  }
  function find(backward = false, incremental = false) {
    clearTimeout(timer);
    if (panel.hidden || !active || active !== getActiveTab()) return;
    if (!input.value) { addon.clearDecorations(); results(); return; }
    addon[backward ? "findPrevious" : "findNext"](input.value, options(incremental));
  }
  function release() {
    clearTimeout(timer);
    listener?.dispose();
    addon?.dispose();
    listener = addon = active = null;
  }
  function bind() {
    if (!enabled) return;
    const tab = getActiveTab();
    toggle.disabled = !tab || tab.moving;
    if (panel.hidden || active === tab) return;
    release();
    results();
    if (!tab) { close(false); return; }
    active = tab;
    addon = new SearchAddon({ highlightLimit: 1000 });
    tab.term.loadAddon(addon);
    listener = addon.onDidChangeResults(results);
    find(false, true);
  }
  function close(focus = true) {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    release();
    results();
    if (focus) getActiveTab()?.term.focus();
  }
  toggle.onclick = () => {
    if (!enabled) return;
    if (!panel.hidden) { close(); return; }
    showTerminal();
    const tab = getActiveTab();
    if (!tab || tab.moving) return;
    const selection = tab.term.getSelection();
    if (selection && !/[\r\n]/.test(selection) && selection.length <= 1000) input.value = selection;
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    bind();
    input.focus();
    input.select();
  };
  panel.onsubmit = event => { event.preventDefault(); find(); };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => find(false, true), 80); };
  panel.onkeydown = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey); }
  };
  previous.onclick = () => find(true);
  next.onclick = () => find();
  $("#terminal-search-close").onclick = () => close();
  $("#terminal-search-case").onclick = event => {
    const button = event.currentTarget;
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
    // Rebuild the cached matches even when only the search flags changed.
    addon?.clearDecorations();
    find(false, true);
  };
  results();
  return {
    activate: bind,
    close,
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      toggle.hidden = !enabled;
      if (enabled) bind();
      else {
        toggle.disabled = true;
        close(panel.contains(document.activeElement));
        input.value = "";
      }
    },
    refreshTheme() { if (addon) { addon.clearDecorations(); find(false, true); } },
    remove(tab) {
      if (active === tab) release();
    },
  };
}
