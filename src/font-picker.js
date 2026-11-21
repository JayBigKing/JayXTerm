import { validFontFamily } from "./terminal-settings.mjs";

let catalog;
const fold = value => value.normalize("NFKC").toLocaleLowerCase();
function localFonts(refresh) {
  if (refresh) catalog = null;
  if (!catalog) {
    const request = (async () => {
      if (typeof window.queryLocalFonts !== "function") throw new Error("当前系统不支持读取本机字体");
      const faces = await window.queryLocalFonts();
      const families = new Map();
      for (const { family } of faces) {
        if (!validFontFamily(family)) continue;
        const name = family.trim(), key = fold(name);
        if (!families.has(key)) families.set(key, { name, key });
      }
      const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      return [...families.values()].sort((a, b) => compare.compare(a.name, b.name));
    })();
    catalog = request;
    request.catch(() => { if (catalog === request) catalog = null; });
  }
  return catalog;
}

export function installFontPicker(dialog, form) {
  const $ = selector => dialog.querySelector(selector);
  const popup = $("#font-picker"), search = $("#font-picker-search");
  const list = $("#font-picker-list"), space = $("#font-picker-space");
  const status = $("#font-picker-status"), refresh = $("#font-picker-refresh");
  const rowHeight = 32, overscan = 3;
  const choices = [
    { field: form.elements.fontFamily, button: $("#settings-font-family-picker"), label: "西文字体" },
    { field: form.elements.cjkFontFamily, button: $("#settings-cjk-font-family-picker"), label: "中文字体", automatic: true },
  ];
  let target, fonts = [], matches = [], active = -1, generation = 0, loading = false;

  function sync() {
    for (const { field, button } of choices) {
      button.querySelector("span").textContent = field.value || "系统默认";
      button.title = field.value || "系统默认（自动回退）";
    }
  }
  function closed() {
    target?.button.setAttribute("aria-expanded", "false");
    target = null;
    generation++;
    search.removeAttribute("aria-activedescendant");
  }
  function close(focus = false) {
    const button = target?.button;
    if (popup.matches(":popover-open")) popup.hidePopover();
    else closed();
    if (focus && dialog.open) button?.focus();
  }
  popup.addEventListener("beforetoggle", event => { if (event.newState === "closed") closed(); });
  function position() {
    if (!target) return;
    const rect = target.button.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 330), window.innerWidth - 24);
    popup.style.width = width + "px";
    popup.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px";
    popup.style.top = Math.max(12, Math.min(rect.bottom + 5, window.innerHeight - popup.offsetHeight - 12)) + "px";
  }
  function render() {
    if (!target) return;
    const start = Math.max(0, Math.floor(list.scrollTop / rowHeight) - overscan);
    const end = Math.min(matches.length, Math.ceil((list.scrollTop + list.clientHeight) / rowHeight) + overscan);
    const rows = [];
    search.removeAttribute("aria-activedescendant");
    for (let index = start; index < end; index++) {
      const item = matches[index];
      const row = document.createElement("div");
      row.id = `font-picker-option-${index}`;
      row.className = "font-picker-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      row.setAttribute("aria-posinset", String(index + 1));
      row.setAttribute("aria-setsize", String(matches.length));
      row.dataset.current = String(item.name === target.field.value);
      row.style.top = index * rowHeight + "px";
      row.textContent = item.name || "系统默认（自动回退）";
      row.title = row.textContent;
      row.onmousedown = event => event.preventDefault();
      row.onclick = () => choose(index);
      rows.push(row);
      if (index === active) search.setAttribute("aria-activedescendant", row.id);
    }
    space.replaceChildren(...rows);
  }
  function revealActive() {
    if (active >= 0) {
      const top = active * rowHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + rowHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + rowHeight - list.clientHeight;
    }
    render();
  }
  function filter() {
    if (!target) return;
    const query = fold(search.value.trim());
    const all = target.automatic ? [{ name: "", key: "系统默认 自动回退 auto" }, ...fonts] : fonts;
    matches = all.filter(item => item.key.includes(query));
    active = matches.findIndex(item => item.name === target.field.value);
    if (active < 0 && matches.length) active = 0;
    space.style.height = matches.length * rowHeight + "px";
    list.scrollTop = 0;
    if (!loading) status.textContent = matches.length ? `${matches.length} 个选项` : "没有匹配的字体";
    revealActive();
  }
  async function load(reload = false) {
    const version = ++generation;
    loading = true;
    refresh.disabled = true;
    list.setAttribute("aria-busy", "true");
    status.textContent = "正在读取本机字体…";
    try {
      const result = await localFonts(reload);
      if (version !== generation || !target) return;
      fonts = result;
      loading = false;
      filter();
      if (target.field.value && !fonts.some(item => item.key === fold(target.field.value)))
        status.textContent = "当前字体未在本机找到，将自动回退。请选择已安装的字体。";
    } catch (error) {
      if (version !== generation || !target) return;
      loading = false;
      filter();
      status.textContent = "无法读取本机字体，请重试。已保存的字体仍可使用。";
      status.title = error.message;
    } finally {
      if (version === generation) {
        loading = false;
        refresh.disabled = false;
        list.setAttribute("aria-busy", "false");
      }
    }
  }
  function choose(index) {
    if (!target || !matches[index]) return;
    const field = target.field;
    field.value = matches[index].name;
    close(true);
    sync();
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  for (const choice of choices) {
    let closingPointer = false;
    // Native light dismissal can hide the popover before the button's click.
    // Remember the pointer-down state so that the same click cannot reopen it.
    choice.button.onpointerdown = () => { closingPointer = target === choice; };
    choice.button.onclick = event => {
      const shouldClose = target === choice || (event.detail > 0 && closingPointer);
      closingPointer = false;
      if (shouldClose) { close(true); return; }
      close();
      target = choice;
      search.value = "";
      status.title = "";
      $("#font-picker-title").textContent = `选择${choice.label}`;
      choice.button.setAttribute("aria-expanded", "true");
      popup.showPopover();
      position();
      filter();
      search.focus();
      void load();
    };
  }
  search.oninput = event => { if (!event.isComposing) filter(); };
  search.addEventListener("compositionend", filter);
  list.onscroll = render;
  popup.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(true);
    } else if (event.target === search) {
      const step = Math.max(1, Math.floor(list.clientHeight / rowHeight));
      const moves = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + step, PageUp: active - step };
      if (Object.hasOwn(moves, event.key)) {
        event.preventDefault();
        active = Math.max(0, Math.min(matches.length - 1, moves[event.key]));
        revealActive();
      } else if (event.key === "Enter") {
        event.preventDefault(); choose(active);
      }
    }
  });
  refresh.onclick = () => { search.focus(); void load(true); };
  $("#font-picker-close").onclick = () => close(true);
  dialog.addEventListener("close", () => close());
  $(".settings-content").addEventListener("scroll", () => close());
  window.addEventListener("resize", position);
  return { sync, close };
}
