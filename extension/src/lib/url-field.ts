// Split a typed URL into {host, path}. `host` is everything up to and including
// the first `.eth` / `.gwei`; `path` is whatever follows. Callers use this to
// paint the host portion bright and dim the path — mirroring how Chrome/Firefox
// render their omnibox.
export function splitUrl(text: string): { host: string; path: string } {
  const m = text.match(/^(.+?\.(?:eth|gwei))(.*)$/i);
  if (!m) return { host: text, path: "" };
  return { host: m[1]!, path: m[2]! };
}

export function colorize(el: HTMLElement, text: string): void {
  el.textContent = "";
  if (!text) return;
  const { host, path } = splitUrl(text);
  const h = document.createElement("span");
  h.className = "u-host";
  h.textContent = host;
  el.appendChild(h);
  if (path) {
    const p = document.createElement("span");
    p.className = "u-path";
    p.textContent = path;
    el.appendChild(p);
  }
}

export interface AddressField {
  element: HTMLElement;
  setValue(text: string): void;
  getValue(): string;
  selectAll(): void;
  shake(): void;
}

// Wire a contenteditable element into an address-bar-style input: mixed
// coloring (host bright, path dim), Enter-to-submit, Escape-to-reset,
// focus-to-select-all, paste-as-plain-text.
export function setupAddressField(
  el: HTMLElement,
  opts: {
    // The root used to read the current Selection. For content scripts that
    // attach a shadow root, pass it here; `shadowRoot.getSelection()` is
    // required to see caret positions inside the shadow (Chrome proprietary
    // API, works on closed roots from inside the same script).
    shadowRoot?: ShadowRoot;
    placeholder?: string;
    onSubmit: (text: string) => void;
    onEscape?: () => void;
  },
): AddressField {
  el.setAttribute("contenteditable", "plaintext-only");
  el.setAttribute("spellcheck", "false");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-label", "ENS address");
  if (opts.placeholder) el.setAttribute("data-placeholder", opts.placeholder);

  const getSelectionObj = (): Selection | null => {
    const sr = opts.shadowRoot as unknown as
      | { getSelection?: () => Selection | null }
      | undefined;
    if (sr?.getSelection) return sr.getSelection() ?? null;
    return window.getSelection();
  };

  const getText = () => el.textContent ?? "";

  const getCaretOffset = (): number | null => {
    const sel = getSelectionObj();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString().length;
  };

  const setCaretOffset = (offset: number): void => {
    const sel = getSelectionObj();
    if (!sel) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let remaining = offset;
    let targetNode: Text | null = null;
    let at = 0;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const len = node.length;
      if (remaining <= len) {
        targetNode = node;
        at = remaining;
        break;
      }
      remaining -= len;
    }
    const range = document.createRange();
    if (targetNode) {
      range.setStart(targetNode, at);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const rerender = () => {
    const offset = getCaretOffset();
    colorize(el, getText());
    if (offset != null) setCaretOffset(offset);
  };

  el.addEventListener("input", rerender);

  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      opts.onSubmit(getText());
    } else if (e.key === "Escape") {
      e.preventDefault();
      opts.onEscape?.();
    }
  });

  // Paste-as-plain-text fallback. `plaintext-only` covers this in Chromium
  // but not in every engine; keep the handler so the behavior is uniform.
  el.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    document.execCommand("insertText", false, text);
  });

  const api: AddressField = {
    element: el,
    setValue(text: string) {
      colorize(el, text);
    },
    getValue() {
      return getText();
    },
    selectAll() {
      const sel = getSelectionObj();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    },
    shake() {
      el.classList.remove("shake");
      void el.offsetWidth;
      el.classList.add("shake");
      setTimeout(() => el.classList.remove("shake"), 450);
    },
  };

  el.addEventListener("focus", () => {
    // Mirror browser address-bar: focusing selects the current value.
    setTimeout(() => api.selectAll(), 0);
  });

  return api;
}
