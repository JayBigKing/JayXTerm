import { SearchAddon } from "@xterm/addon-search";

export function installTerminalSearch({ getActiveTab, showTerminal, getTheme }) {
  const $ = selector => document.querySelector(selector);
  const panel = $("#terminal-search"), input = $("#terminal-search-input");
  const toggle = $("#terminal-search-toggle"), count = $("#terminal-search-count");
  const previous = $("#terminal-search-previous"), next = $("#terminal-search-next");
  let active, listener, timer;
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
    if (!input.value) { active.search.clearDecorations(); results(); return; }
    active.search[backward ? "findPrevious" : "findNext"](input.value, options(incremental));
  }
  function bind() {
    const tab = getActiveTab();
    toggle.disabled = !tab || tab.moving;
    if (active === tab) return;
    listener?.dispose();
    active?.search?.clearDecorations();
    active = tab;
    results();
    if (!active) { close(false); return; }
    if (!active.search) {
      active.search = new SearchAddon({ highlightLimit: 1000 });
      active.term.loadAddon(active.search);
    }
    listener = active.search.onDidChangeResults(results);
    if (!panel.hidden) find(false, true);
  }
  function close(focus = true) {
    clearTimeout(timer);
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    active?.search?.clearDecorations();
    results();
    if (focus) getActiveTab()?.term.focus();
  }
  toggle.onclick = () => {
    if (!panel.hidden) { close(); return; }
    showTerminal();
    bind();
    if (!active) return;
    const selection = active.term.getSelection();
    if (selection && !/[\r\n]/.test(selection) && selection.length <= 1000) input.value = selection;
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    find(false, true);
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
    active?.search.clearDecorations();
    find(false, true);
  };
  results();
  return {
    activate: bind,
    close,
    refreshTheme() { if (!panel.hidden) { active?.search.clearDecorations(); find(false, true); } },
    remove(tab) {
      if (active !== tab) return;
      listener?.dispose();
      listener = null;
      active.search?.clearDecorations();
      active = null;
    },
  };
}
