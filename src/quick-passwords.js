import { terminalPasswordPrompt } from "./terminal-password-prompt.mjs";
import { trashIcon } from "./file-icons.js";

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === "button") node.type = "button";
  return node;
};

function terminalCursorBounds(tab) {
  const { term } = tab, buffer = term.buffer.active;
  const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
  const screen = term.element.querySelector(".xterm-screen");
  if (buffer.type !== "normal" || row < 0 || row >= term.rows ||
      !screen?.checkVisibility({ visibilityProperty: true })) return null;
  const bounds = screen.getBoundingClientRect();
  const width = bounds.width / term.cols, height = bounds.height / term.rows;
  const left = bounds.left + Math.min(buffer.cursorX, term.cols - 1) * width;
  const top = bounds.top + row * height;
  return { left, right: left + width, top, bottom: top + height };
}

export function installQuickPasswords({ api, getActiveTab, showTerminal, toast }) {
  const $ = selector => document.querySelector(selector);
  const settings = $("#settings-dialog"), vaultList = $("#vault-list");
  const passwordPanel = $("#settings-passwords");
  const editor = $("#quick-password-editor"), form = $("#quick-password-form");
  const secret = $("#quick-password-secret"), reveal = $("#quick-password-reveal");
  const picker = $("#quick-password-picker"), filter = $("#quick-password-filter");
  const options = $("#quick-password-options"), terminalButton = $("#terminal-passwords");
  let metadata = { available: true, items: [] }, loaded = false, loading;
  let dataVersion = 0, rowVersion = 0, editVersion = 0, pickerVersion = 0, target, selectedId;
  let suppressFocus;
  const watchers = new Map();
  function concealRows() {
    rowVersion++;
    for (const input of vaultList.querySelectorAll(".vault-secret")) {
      input.value = "";
      input.type = "password";
    }
    for (const button of vaultList.querySelectorAll(".vault-reveal")) {
      button.textContent = "显示";
      button.setAttribute("aria-pressed", "false");
    }
  }
  function renderVault() {
    if (!settings.open) return;
    concealRows();
    vaultList.replaceChildren();
    $("#vault-add").disabled = !metadata.available;
    $("#vault-note").textContent = metadata.available ? "" : "系统安全存储不可用，暂时无法读取或保存密码。";
    if (!metadata.items.length) vaultList.append(element("p", "form-note", "还没有快捷密码，点击「新增密码」开始。"));
    for (const item of metadata.items) {
      const row = element("div", "vault-row");
      row.dataset.passwordId = item.id;
      const description = element("strong", "vault-description", item.description);
      description.title = item.description;
      const input = element("input", "vault-secret");
      input.type = "password";
      input.readOnly = true;
      input.placeholder = "••••••••";
      input.autocomplete = "off";
      input.setAttribute("aria-label", item.description + "的密码");
      const view = element("button", "vault-reveal", "显示");
      view.disabled = !metadata.available;
      view.setAttribute("aria-pressed", "false");
      view.onclick = async () => {
        if (input.type === "text") {
          input.value = ""; input.type = "password";
          view.textContent = "显示"; view.setAttribute("aria-pressed", "false");
          return;
        }
        const version = rowVersion;
        view.disabled = true;
        try {
          const value = await api.revealQuickPassword(item.id);
          if (version !== rowVersion || !row.isConnected || !settings.open || passwordPanel.hidden) return;
          input.value = value; input.type = "text";
          view.textContent = "隐藏"; view.setAttribute("aria-pressed", "true");
        } catch (error) { $("#vault-note").textContent = error.message; }
        finally { view.disabled = !metadata.available; }
      };
      const edit = element("button", "vault-edit", "编辑");
      edit.disabled = !metadata.available;
      edit.onclick = () => openEditor(item);
      const remove = element("button", "vault-remove");
      remove.append(trashIcon());
      remove.title = "删除快捷密码 " + item.description;
      remove.setAttribute("aria-label", "删除快捷密码 " + item.description);
      remove.onclick = async () => {
        remove.disabled = true;
        try { if ((await api.removeQuickPassword(item.id)).removed) await load(true); }
        catch (error) { $("#vault-note").textContent = error.message; }
        finally { remove.disabled = false; }
      };
      row.append(description, input, view, edit, remove);
      vaultList.append(row);
    }
  }
  function load(force = false) {
    if (!force && loaded) return Promise.resolve(metadata);
    if (!force && loading) return loading;
    const version = ++dataVersion;
    loading = api.quickPasswords().then(result => {
      if (version !== dataVersion) return metadata;
      metadata = result;
      loaded = true;
      renderVault();
      if (picker.matches(":popover-open")) renderOptions();
      return result;
    }).finally(() => { if (version === dataVersion) loading = null; });
    return loading;
  }
  function openEditor(item) {
    concealRows();
    editVersion++;
    form.reset();
    form.elements.id.value = item?.id || "";
    form.elements.description.value = item?.description || "";
    secret.type = "password";
    secret.required = !item;
    secret.placeholder = item ? "留空保留现有密码" : "输入密码";
    reveal.textContent = "显示";
    reveal.setAttribute("aria-pressed", "false");
    $("#quick-password-editor-title").textContent = item ? "编辑快捷密码" : "新增快捷密码";
    $("#quick-password-editor-note").textContent = item ? "只修改描述时，密码可以留空。" : "保存后可以按描述选择并填入。";
    $("#quick-password-error").textContent = "";
    editor.showModal();
    form.elements.description.focus();
  }
  $("#vault-add").onclick = () => openEditor();
  $("#quick-password-cancel").onclick = () => editor.close();
  editor.addEventListener("close", () => {
    editVersion++;
    form.reset(); secret.value = ""; secret.type = "password";
  });
  reveal.onclick = async () => {
    if (secret.type === "text") {
      secret.type = "password"; reveal.textContent = "显示"; reveal.setAttribute("aria-pressed", "false");
      return;
    }
    const version = editVersion;
    reveal.disabled = true;
    try {
      if (!secret.value && form.elements.id.value) {
        const value = await api.revealQuickPassword(form.elements.id.value);
        if (version !== editVersion || !editor.open) return;
        if (!secret.value) secret.value = value;
      }
      secret.type = "text"; reveal.textContent = "隐藏"; reveal.setAttribute("aria-pressed", "true");
    } catch (error) { $("#quick-password-error").textContent = error.message; }
    finally { reveal.disabled = false; }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const button = $("#quick-password-save");
    if (button.disabled) return;
    button.disabled = true;
    const version = editVersion;
    try {
      await api.saveQuickPassword({ id: form.elements.id.value, description: form.elements.description.value, password: secret.value });
      if (version === editVersion && editor.open) editor.close();
      await load(true);
    } catch (error) { if (version === editVersion) $("#quick-password-error").textContent = error.message; }
    finally { button.disabled = false; }
  };
  new MutationObserver(() => {
    if (settings.open) load(true).catch(error => { $("#vault-note").textContent = error.message; });
    else {
      concealRows(); vaultList.replaceChildren();
      if (editor.open) editor.close();
      watchers.get(getActiveTab()?.id)?.schedule();
    }
  }).observe(settings, { attributes: true, attributeFilter: ["open"] });
  // Cover mouse, keyboard and validation-driven section changes alike.
  new MutationObserver(() => {
    if (passwordPanel.hidden) concealRows();
  }).observe(passwordPanel, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("blur", concealRows);

  function closePicker() {
    pickerVersion++;
    target?.field?.setAttribute("aria-expanded", "false");
    target = null;
    selectedId = null;
    if (picker.matches(":popover-open")) picker.hidePopover();
    terminalButton.setAttribute("aria-expanded", "false");
    filter.value = "";
    options.replaceChildren();
  }
  function validTarget(value) {
    if (value.field) return value.field.isConnected && value.field.closest("dialog")?.open;
    const tab = getActiveTab();
    return tab === value.tab && tab.state === "已连接" && !tab.moving && !tab.term.options.disableStdin &&
      (!value.automatic || (terminalPasswordPrompt(tab.term)?.key === value.key &&
        !value.marker?.isDisposed && value.marker?.line === tab.term.buffer.active.baseY + tab.term.buffer.active.cursorY &&
        terminalCursorBounds(tab)));
  }
  async function choose(item) {
    const selection = target, version = pickerVersion;
    if (!selection || !validTarget(selection)) { closePicker(); return; }
    if (selection.pending) return;
    selection.pending = true;
    for (const button of options.querySelectorAll("button")) button.disabled = true;
    try {
      if (selection.field) {
        const value = await api.revealQuickPassword(item.id);
        if (version !== pickerVersion || !validTarget(selection)) return;
        selection.field.value = value;
        selection.field.type = "password";
        selection.toggle.textContent = "显示";
        selection.toggle.setAttribute("aria-pressed", "false");
        selection.field.dispatchEvent(new Event("input", { bubbles: true }));
        closePicker();
        selection.field.focus();
      } else {
        watchers.get(selection.tab.id)?.suppress();
        selection.tab.term.scrollToBottom();
        await api.fillQuickPassword({ id: selection.tab.id, passwordId: item.id });
        if (version === pickerVersion) closePicker();
        if (getActiveTab() === selection.tab) selection.tab.term.focus();
      }
    } catch (error) { closePicker(); toast(error.message); }
  }
  function selectOption(button, focus = false) {
    selectedId = button.dataset.passwordId;
    for (const sibling of options.querySelectorAll("button"))
      sibling.setAttribute("aria-selected", String(sibling === button));
    if (focus) {
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: "nearest" });
    }
  }
  function positionPicker() {
    if (!target || !picker.matches(":popover-open")) return;
    const atCursor = target.tab && target.automatic;
    const anchor = atCursor ? terminalCursorBounds(target.tab) : (target.field || terminalButton).getBoundingClientRect();
    if (!anchor) { closePicker(); return; }
    const { width, height } = picker.getBoundingClientRect();
    const margin = 8, gap = 6;
    let left = anchor.left, top = anchor.bottom + gap;
    if (atCursor) {
      left = anchor.right + gap;
      top = anchor.top;
      if (left + width > innerWidth - margin) left = anchor.left - width - gap;
      if (left < margin) { left = anchor.left; top = anchor.bottom + gap; }
    } else if (!target.field || top + height > innerHeight - margin) top = anchor.top - height - gap;
    picker.style.left = `${Math.max(margin, Math.min(left, innerWidth - width - margin))}px`;
    picker.style.top = `${Math.max(margin, Math.min(top, innerHeight - height - margin))}px`;
    picker.style.bottom = "auto";
  }
  function renderOptions() {
    options.replaceChildren();
    const query = filter.value.trim().toLocaleLowerCase();
    const items = metadata.items.filter(item => item.description.toLocaleLowerCase().includes(query));
    if (!metadata.available || !items.length) {
      selectedId = null;
      options.append(element("p", "form-note", !metadata.available ? "系统安全存储不可用" :
        metadata.items.length ? "没有匹配的密码描述" : "还没有快捷密码，可以到设置中添加。"));
      positionPicker();
      return;
    }
    if (!items.some(item => item.id === selectedId))
      selectedId = target?.tab && target.automatic ? null : items[0].id;
    for (const item of items) {
      const button = element("button", "quick-password-option");
      button.dataset.passwordId = item.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(item.id === selectedId));
      button.disabled = !!target?.pending;
      button.append(element("span", "", item.description), element("small", "", target?.field ? "填入" : "填入并提交"));
      const selection = target, version = pickerVersion;
      button.onclick = () => {
        if (target === selection && pickerVersion === version) choose(item);
      };
      if (!(target?.tab && target.automatic)) button.onfocus = () => selectOption(button);
      options.append(button);
    }
    positionPicker();
  }
  async function openPicker(selection) {
    closePicker();
    const version = pickerVersion;
    try {
      await load();
      if (version !== pickerVersion || !validTarget(selection) ||
          (selection.automatic && (!metadata.items.length || !metadata.available ||
            (selection.tab && document.querySelector("dialog[open]")) ||
            (selection.field && (document.activeElement !== selection.field || selection.field.value))))) return;
      target = selection;
      const parent = selection.field?.closest("dialog") || document.body;
      parent.append(picker);
      const atCursor = selection.tab && selection.automatic;
      picker.dataset.anchor = atCursor ? "cursor" : "control";
      filter.hidden = !!atCursor;
      $("#quick-password-target").textContent = selection.field ? "填入连接密码，确认后再连接。" :
        atCursor ? "↑/↓ 选择 · Enter 填入并提交 · Esc 关闭" :
        `${selection.tab.session.username}@${selection.tab.session.host} · 选取后填入并提交`;
      renderOptions();
      picker.showPopover();
      positionPicker();
      selection.field?.setAttribute("aria-expanded", "true");
      if (selection.tab) terminalButton.setAttribute("aria-expanded", "true");
      if (!selection.automatic) filter.focus();
    } catch (error) { if (!selection.automatic) toast(error.message); }
  }
  function moveOption(event) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...options.querySelectorAll("button:not(:disabled)")];
    if (!buttons.length) return;
    const index = buttons.findIndex(button => button.dataset.passwordId === selectedId);
    const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) :
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    selectOption(buttons[next], true);
  }
  filter.oninput = renderOptions;
  $("#quick-password-picker-close").onclick = closePicker;
  $("#quick-password-manage").onclick = async () => {
    closePicker();
    await $("#settings-open").onclick();
    $("#settings-tab-passwords").click();
  };
  document.addEventListener("pointerdown", event => {
    if (target && !picker.contains(event.target) && event.target !== target.field &&
        !event.target.closest(".password-book-button, #terminal-passwords")) closePicker();
  }, true);
  document.addEventListener("keydown", event => {
    if (!target || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      const field = target.field;
      closePicker();
      if (field?.isConnected) {
        suppressFocus = field; field.focus(); suppressFocus = null;
      } else getActiveTab()?.term.focus();
      return;
    }
    const terminalInput = target.tab?.term.element.contains(event.target);
    const pickerInput = event.target === filter || event.target.closest(".quick-password-option");
    if (!terminalInput && !pickerInput && event.target !== target.field) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) moveOption(event);
    else if (event.key === "Enter" && (terminalInput || pickerInput)) {
      const selected = options.querySelector('button[aria-selected="true"]');
      if (selected || (target.automatic && target.tab && pickerInput)) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) selected?.click();
      }
    }
  }, true);
  window.addEventListener("resize", positionPicker);
  terminalButton.onclick = () => {
    if (target?.tab) { closePicker(); return; }
    showTerminal();
    const tab = getActiveTab();
    if (tab) openPicker({ tab, automatic: false });
  };
  function attachField(field, button, toggle) {
    field.setAttribute("aria-controls", picker.id);
    field.setAttribute("aria-expanded", "false");
    field.addEventListener("focus", () => { if (!field.value && suppressFocus !== field) openPicker({ field, toggle, automatic: true }); });
    field.addEventListener("input", () => { if (target?.field === field) closePicker(); });
    field.closest("dialog").addEventListener("close", () => { if (target?.field === field) closePicker(); });
    button.onclick = () => {
      if (target?.field === field) closePicker();
      else openPicker({ field, toggle, automatic: false });
    };
  }
  attachField($("#session-form").elements.password, $("#session-quick-password"), $("#toggle-password"));
  attachField($("#connect-password"), $("#connect-quick-password"), $("#toggle-connect-password"));
  api.onWindow(event => {
    if (event.type === "passwords-changed") load(true).catch(error => toast(error.message));
  });
  return {
    activate() {
      const tab = getActiveTab();
      terminalButton.disabled = !tab || tab.state !== "已连接" || tab.moving;
      if (target?.tab && !validTarget(target)) closePicker();
      watchers.get(tab?.id)?.schedule();
    },
    userInput(tab) {
      watchers.get(tab.id)?.suppress();
      if (!target || target.tab === tab) closePicker();
    },
    watch(tab) {
      let frame, disposed = false, lastPrompt, promptMarker;
      const cursorRow = () => tab.term.buffer.active.baseY + tab.term.buffer.active.cursorY;
      const samePrompt = prompt => prompt && lastPrompt === prompt.key &&
        !promptMarker?.isDisposed && promptMarker?.line === cursorRow();
      function remember(prompt) {
        if (samePrompt(prompt)) return;
        promptMarker?.dispose();
        lastPrompt = prompt?.key;
        // Markers distinguish a new prompt even when full scrollback reuses its row.
        promptMarker = prompt ? tab.term.registerMarker() : null;
      }
      function check() {
        frame = null;
        if (disposed) return;
        const prompt = terminalPasswordPrompt(tab.term);
        if (!prompt) {
          remember(null);
          if (target?.tab === tab && target.automatic) closePicker();
          return;
        }
        if (target?.tab === tab && target.automatic) {
          if (!validTarget(target)) closePicker();
          else positionPicker();
        }
        if (getActiveTab() !== tab || tab.state !== "已连接" || tab.moving ||
            document.querySelector("dialog[open]") || samePrompt(prompt) || !terminalCursorBounds(tab)) return;
        remember(prompt);
        openPicker({ tab, key: prompt.key, marker: promptMarker, automatic: true });
      }
      function schedule() { if (!disposed && frame == null) frame = requestAnimationFrame(check); }
      const listeners = [tab.term.onWriteParsed(schedule), tab.term.onScroll(schedule),
        tab.term.onResize(schedule), tab.term.onRender(schedule)];
      const watcher = {
        schedule,
        suppress() { remember(terminalPasswordPrompt(tab.term)); },
        dispose() {
          disposed = true; cancelAnimationFrame(frame); listeners.forEach(listener => listener.dispose()); watchers.delete(tab.id);
          promptMarker?.dispose();
          if (target?.tab === tab) closePicker();
        },
      };
      watchers.set(tab.id, watcher);
      return watcher;
    },
  };
}
