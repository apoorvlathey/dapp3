import type { TabContext } from "@/lib/messaging";
import type { HeliosStatus } from "@/lib/helios-bridge";
import { setupAddressField, type AddressField } from "@/lib/url-field";

const BANNER_ID = "dapp3-banner";
const HEIGHT_PX = 44;
const POLL_MS = 2000;

async function getCtx(): Promise<TabContext | null> {
  const resp = await chrome.runtime.sendMessage({ type: "get-tab-ctx" });
  return resp?.ctx ?? null;
}

async function getHeliosStatus(): Promise<HeliosStatus | null> {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "get-helios-status" });
    return resp?.ok ? (resp.status as HeliosStatus) : null;
  } catch {
    return null;
  }
}

type Dot = "ok" | "syncing" | "caution" | "warn";

function pickDot(ctx: TabContext, status: HeliosStatus | null): {
  dot: Dot;
  label: string;
  title: string;
} {
  if (ctx.trustedDirectly) {
    return {
      dot: "caution",
      label: "RPC-trusted",
      title:
        "This page was resolved by trusting your RPC directly (Helios bypassed). The ENS→content mapping was not verified against Ethereum consensus.",
    };
  }
  if (!status) {
    return {
      dot: "ok",
      label: "Helios-verified",
      title: "ENS resolution was verified by Helios against Ethereum consensus.",
    };
  }
  switch (status.state) {
    case "synced":
      return {
        dot: "ok",
        label: "Helios-verified",
        title:
          "ENS resolution was verified by Helios against Ethereum consensus.",
      };
    case "syncing":
    case "booting":
      return {
        dot: "syncing",
        label: `Helios ${status.state}…`,
        title: `Helios is ${status.state}. This page was resolved earlier; Helios is catching up for subsequent resolutions.`,
      };
    case "idle":
      return {
        dot: "syncing",
        label: "Helios idle",
        title: "Helios has not started yet for this session.",
      };
    case "error":
      return {
        dot: "warn",
        label: "Helios error",
        title: `Helios error: ${status.error ?? "unknown"}`,
      };
  }
}

function currentPath(): string {
  const p = location.pathname + location.search + location.hash;
  return p === "/" ? "" : p;
}

function underlyingUrl(): string {
  return location.href;
}

type Refs = {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  dot: HTMLSpanElement;
  statusWrap: HTMLSpanElement;
  stateText: HTMLSpanElement;
  urlForm: HTMLElement;
  urlInput: HTMLElement;
  menuBtn: HTMLButtonElement;
  menu: HTMLDivElement;
  copyItem: HTMLButtonElement;
  settingsItem: HTMLButtonElement;
  copyToast: HTMLSpanElement;
};

// Parse an address-bar-style input into a navigable `http://<name>.eth/...` URL.
// Returns null when the input isn't a `.eth` target (matches the scope enforced
// by the SW's ETH_HOST_RE + the DNR rule's regexFilter). Accepts subdomains.
function parseEthInput(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "");
  if (!trimmed) return null;
  const m = trimmed.match(/^([^\/\?#]+)(.*)$/);
  if (!m || !m[1]) return null;
  const host = m[1].toLowerCase();
  const rest = m[2] || "/";
  if (!/^(?:[a-z0-9-]+\.)+eth$/.test(host)) return null;
  return `http://${host}${rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#") ? rest : `/${rest}`}`;
}

function buildBanner(): Refs {
  const host = document.createElement("div");
  host.id = BANNER_ID;
  host.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    `height:${HEIGHT_PX}px`,
    "z-index:2147483647",
    "pointer-events:auto",
    "margin:0",
    "padding:0",
    "border:0",
  ].join(";");

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .bar {
      display: flex; align-items: center; gap: 10px;
      height: ${HEIGHT_PX}px; padding: 0 10px 0 12px;
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      background: #09090b; color: #f4f4f5;
      border-bottom: 1px solid #27272a;
    }
    .brand-mark {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 4px;
      background: #18181b; border: 1px solid #27272a;
      flex: none;
    }
    .brand-mark svg { width: 12px; height: 12px; display: block; }
    .status {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 3px 8px; border-radius: 4px;
      background: #18181b; border: 1px solid #27272a;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; flex: none; }
    .dot.ok { background: #10b981; }
    .dot.syncing {
      background: #fbbf24;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .dot.caution { background: #fbbf24; }
    .dot.warn { background: #f43f5e; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }
    .statelabel {
      color: #a1a1aa; font-weight: 500;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .status.ok  .statelabel  { color: #6ee7b7; }
    .status.caution .statelabel { color: #fbbf24; }
    .status.warn .statelabel { color: #fb7185; }
    .left, .right {
      display: inline-flex; align-items: center; gap: 10px;
      flex: 1 1 0; min-width: 0;
    }
    .right { justify-content: flex-end; }
    .identity {
      display: inline-flex; align-items: center; gap: 8px;
      flex: 0 1 560px; min-width: 0;
      height: 24px; padding: 0 10px;
      background: #18181b; border: 1px solid #27272a;
      border-radius: 12px;
      transition: border-color 150ms, background-color 150ms;
    }
    .identity:hover { background: #1f1f22; }
    .identity:focus-within {
      background: #09090b;
      border-color: #3f3f46;
    }
    .identity svg.magnifier {
      width: 12px; height: 12px; color: #71717a; flex: none; display: block;
      transition: color 150ms;
    }
    .identity:focus-within svg.magnifier { color: #a1a1aa; }
    .identity .urlfield {
      flex: 1 1 auto; min-width: 0;
      font: 500 12px/1 "SF Mono", Menlo, Monaco, ui-monospace, monospace;
      color: #6ee7b7;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      outline: none;
      cursor: text;
    }
    .identity .urlfield:empty::before {
      content: attr(data-placeholder);
      color: #52525b;
    }
    .identity .urlfield .u-host { color: #6ee7b7; }
    .identity .urlfield .u-path { color: #6ee7b7; opacity: 0.5; }
    .identity .urlfield::selection,
    .identity .urlfield *::selection {
      background: rgba(16, 185, 129, 0.3); color: #a7f3d0;
    }
    .identity:has(.urlfield.shake) { border-color: #f43f5e; }
    .urlfield.shake { animation: shake 0.4s ease; }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25%      { transform: translateX(-3px); }
      75%      { transform: translateX(3px); }
    }
    .menu-wrap { position: relative; }
    .menu-btn {
      all: unset;
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border-radius: 4px;
      color: #a1a1aa; cursor: pointer;
      font-size: 16px; line-height: 1;
      transition: background-color 150ms, color 150ms;
    }
    .menu-btn:hover { background: #27272a; color: #f4f4f5; }
    .menu {
      position: absolute; top: calc(100% + 4px); right: 0;
      display: none; min-width: 220px;
      background: #18181b; color: #e4e4e7;
      border: 1px solid #27272a;
      border-radius: 6px; padding: 4px;
    }
    .menu.open { display: block; }
    .menu button {
      all: unset;
      display: block; width: 100%; box-sizing: border-box;
      padding: 7px 10px; border-radius: 4px;
      font: 500 12px/1.3 inherit; color: #e4e4e7; cursor: pointer;
      text-align: left;
      transition: background-color 150ms, color 150ms;
    }
    .menu button:hover { background: #27272a; color: #f4f4f5; }
    .toast {
      display: none;
      color: #6ee7b7; font-weight: 500;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .toast.show { display: inline; }
  `;

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = `
    <span class="left">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 4 L8 17 L16 13 L24 17 Z" fill="#10b981"/>
          <path d="M16 28 L8 19 L16 15 L24 19 Z" fill="#059669"/>
        </svg>
      </span>
      <span class="status">
        <span class="dot"></span>
        <span class="statelabel"></span>
      </span>
    </span>
    <div class="identity" role="search">
      <svg class="magnifier" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5"/>
        <path d="M10.5 10.5 L14 14"/>
      </svg>
      <div class="urlfield"></div>
    </div>
    <span class="right">
      <span class="toast">copied</span>
      <span class="menu-wrap">
        <button class="menu-btn" type="button" aria-label="banner menu" title="Banner options">⋯</button>
        <div class="menu" role="menu">
          <button data-act="copy" type="button">Copy underlying URL</button>
          <button data-act="settings" type="button">Open extension settings</button>
        </div>
      </span>
    </span>
  `;

  shadow.append(style, bar);

  const q = <T extends Element>(sel: string) =>
    shadow.querySelector(sel) as T;

  return {
    host,
    shadow,
    dot: q<HTMLSpanElement>(".dot"),
    statusWrap: q<HTMLSpanElement>(".status"),
    stateText: q<HTMLSpanElement>(".statelabel"),
    urlForm: q<HTMLElement>(".identity"),
    urlInput: q<HTMLElement>(".urlfield"),
    menuBtn: q<HTMLButtonElement>(".menu-btn"),
    menu: q<HTMLDivElement>(".menu"),
    copyItem: q<HTMLButtonElement>('button[data-act="copy"]'),
    settingsItem: q<HTMLButtonElement>('button[data-act="settings"]'),
    copyToast: q<HTMLSpanElement>(".toast"),
  };
}

function applyBodyOffset() {
  const apply = () => {
    if (!document.body) return false;
    const cur = parseFloat(getComputedStyle(document.body).marginTop) || 0;
    document.body.style.marginTop = `${Math.max(cur, HEIGHT_PX)}px`;
    // NOTE: do NOT set transform on <body> to "contain" page-level fixed
    // headers. A transform on <body> makes it the containing block for *all*
    // position:fixed descendants — which breaks dapp wallet-connect modals
    // (RainbowKit, ConnectKit, Web3Modal) that expect viewport anchoring and
    // end up clipped by the 44px body offset. The page's own fixed navs may
    // overlap our banner's 44px; the banner has max z-index so it's still on
    // top, and that overlap is a much smaller UX hit than broken modals.
    return true;
  };
  if (apply()) return;
  // Body doesn't exist yet (we mounted at document_start before <body> parsed).
  // Watch for it and apply the offset the instant it appears, so the page's
  // first paint already accounts for the banner height instead of briefly
  // rendering under it and snapping down at DOMContentLoaded.
  const obs = new MutationObserver(() => {
    if (apply()) obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true });
}

function wireSpaNav(onChange: () => void) {
  const patch = (key: "pushState" | "replaceState") => {
    const orig = history[key];
    history[key] = function (
      this: History,
      ...args: Parameters<typeof orig>
    ) {
      const r = orig.apply(this, args as never);
      queueMicrotask(onChange);
      return r;
    } as typeof orig;
  };
  patch("pushState");
  patch("replaceState");
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
}

function wireMenu(refs: Refs) {
  const close = () => refs.menu.classList.remove("open");
  refs.menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    refs.menu.classList.toggle("open");
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  refs.copyItem.addEventListener("click", async () => {
    close();
    const url = underlyingUrl();
    try {
      await navigator.clipboard.writeText(url);
      refs.copyToast.classList.add("show");
      setTimeout(() => refs.copyToast.classList.remove("show"), 1200);
    } catch {
      // Fallback: temp textarea. Clipboard API requires focus/HTTPS in some contexts.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body?.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        refs.copyToast.classList.add("show");
        setTimeout(() => refs.copyToast.classList.remove("show"), 1200);
      } finally {
        ta.remove();
      }
    }
  });

  refs.settingsItem.addEventListener("click", () => {
    close();
    chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {
      // best-effort; the SW might not handle it, that's fine
    });
  });
}

function wireAddressBar(
  refs: Refs,
  getCurrentValue: () => string,
): AddressField {
  const field: AddressField = setupAddressField(refs.urlInput, {
    shadowRoot: refs.shadow,
    placeholder: "name.eth",
    onSubmit: (text) => {
      const url = parseEthInput(text);
      if (!url) {
        field.shake();
        return;
      }
      // DNR redirects the *.eth main_frame to the interstitial, which then
      // drives the SW resolve. Same path as typing into Chrome's own address bar.
      location.assign(url);
    },
    onEscape: () => {
      field.setValue(getCurrentValue());
      refs.urlInput.blur();
    },
  });
  return field;
}

async function mount(ctx: TabContext) {
  if (document.getElementById(BANNER_ID)) return;

  const refs = buildBanner();
  (document.documentElement || document.body).appendChild(refs.host);

  let currentStatus: HeliosStatus | null = null;
  let inputFocused = false;
  refs.urlInput.addEventListener("focus", () => (inputFocused = true));
  refs.urlInput.addEventListener("blur", () => (inputFocused = false));

  const currentUrlValue = () => `${ctx.ensName}${currentPath()}`;
  const field = wireAddressBar(refs, currentUrlValue);

  const render = () => {
    const { dot, label, title } = pickDot(ctx, currentStatus);
    refs.dot.classList.remove("ok", "syncing", "caution", "warn");
    refs.dot.classList.add(dot);
    refs.dot.title = title;
    refs.statusWrap.classList.remove("ok", "syncing", "caution", "warn");
    refs.statusWrap.classList.add(dot);
    refs.stateText.textContent = label;
    refs.stateText.title = title;

    // Don't stomp the user's in-progress edit.
    if (!inputFocused) field.setValue(currentUrlValue());
  };

  render();
  applyBodyOffset();

  wireSpaNav(render);
  wireMenu(refs);

  // Live Helios status polling. Stops when the banner element is removed.
  (async () => {
    while (document.getElementById(BANNER_ID)) {
      currentStatus = await getHeliosStatus();
      render();
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
}

(async () => {
  const ctx = await getCtx();
  if (!ctx) return;
  mount(ctx);
})();
