import { terminalPasswordPrompt } from "./terminal-password-prompt.mjs";

// Only predict plain ASCII after observing two exact echoes in this editing
// context. Never change xterm's buffer: the server remains its sole author.
export class EchoPrediction {
  constructor() { this.reset(); }
  reset() { this.pending = ""; this.confirmed = 0; this.visible = false; }
  input(data, eligible) {
    if (!eligible || !/^[\x20-\x7e]$/.test(data) || this.pending.length >= 128) {
      this.reset();
      return;
    }
    this.pending += data;
    this.visible = this.confirmed >= 2;
  }
  output(data) {
    // ANSI redraws, control characters, unsolicited output and nonmatching
    // echoes immediately discard the entire prediction, including confidence.
    const text = typeof data === "string" ? data : String.fromCharCode(...data.subarray(0, 129));
    if (!text || text.length > this.pending.length || !this.pending.startsWith(text)) {
      this.reset();
      return;
    }
    this.pending = this.pending.slice(text.length);
    this.confirmed += text.length;
  }
  get text() { return this.visible ? this.pending : ""; }
}

export function installTerminalEcho(tab, enabled = true) {
  const term = tab.term, prediction = new EchoPrediction();
  const screen = term.element.querySelector(".xterm-screen");
  const overlay = document.createElement("div");
  overlay.className = "terminal-echo-preview";
  overlay.setAttribute("aria-hidden", "true");
  overlay.hidden = true;
  screen.append(overlay);
  let timer, frame, writes = 0, disposed = false;
  function eligible() {
    const buffer = term.buffer.active;
    return enabled && !tab.moving && tab.state === "已连接" && !term.options.disableStdin &&
      buffer.type === "normal" && term.modes.bracketedPasteMode &&
      !term.modes.applicationCursorKeysMode && !term.modes.applicationKeypadMode &&
      !terminalPasswordPrompt(term);
  }
  function reset() {
    clearTimeout(timer);
    prediction.reset();
    overlay.hidden = true;
    overlay.textContent = "";
  }
  function render() {
    frame = null;
    if (disposed) return;
    if (!eligible()) { reset(); return; }
    const buffer = term.buffer.active, text = prediction.text;
    if (writes || !text || buffer.viewportY !== buffer.baseY ||
        buffer.cursorX + text.length >= term.cols || !screen.checkVisibility({ visibilityProperty: true })) {
      overlay.hidden = true;
      return;
    }
    // Insertion/redraw in the middle of a line belongs to the remote editor.
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (line?.translateToString(true, buffer.cursorX).trim()) { reset(); return; }
    const width = screen.clientWidth / term.cols, height = screen.clientHeight / term.rows;
    Object.assign(overlay.style, {
      left: buffer.cursorX * width + "px", top: buffer.cursorY * height + "px",
      height: height + "px", lineHeight: height + "px",
      fontFamily: term.options.fontFamily, fontSize: term.options.fontSize + "px",
      color: term.options.theme.foreground, backgroundColor: term.options.theme.background,
    });
    overlay.replaceChildren(...Array.from(text, char => {
      const cell = document.createElement("span");
      cell.textContent = char;
      cell.style.width = width + "px";
      return cell;
    }));
    overlay.hidden = false;
  }
  function schedule() { if (!disposed && frame == null) frame = requestAnimationFrame(render); }
  const listeners = [term.onRender(schedule), term.onScroll(reset), term.onResize(reset),
    term.buffer.onBufferChange(reset)];
  return {
    input(data) {
      prediction.input(data, eligible() && !writes);
      clearTimeout(timer);
      if (prediction.pending) timer = setTimeout(reset, 1000);
      // Show in the same input event; no network or animation-frame wait.
      render();
    },
    output(data) {
      writes++;
      overlay.hidden = true;
      prediction.output(data);
      return () => { writes--; render(); };
    },
    reset,
    setEnabled(value) { enabled = value; reset(); },
    dispose() {
      disposed = true; reset(); cancelAnimationFrame(frame);
      listeners.forEach(listener => listener.dispose()); overlay.remove();
    },
  };
}
