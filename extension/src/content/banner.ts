import type { ContentUpdatedMessage, TabContext } from "@/lib/messaging";
import type { HeliosStatus } from "@/lib/helios-bridge";
import { setupAddressField, type AddressField } from "@/lib/url-field";
import {
  addBookmark,
  isBookmarked,
  normalizePath,
  onBookmarksChanged,
  removeBookmark,
  type Bookmark,
} from "@/lib/bookmarks";

const BANNER_ID = "dapp3-banner";
const HEIGHT_PX = 44;
const UPDATE_STRIP_PX = 32;
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
  brandBtn: HTMLButtonElement;
  dot: HTMLSpanElement;
  statusWrap: HTMLSpanElement;
  stateText: HTMLSpanElement;
  urlForm: HTMLElement;
  urlInput: HTMLElement;
  starBtn: HTMLButtonElement;
  bookmarksBtn: HTMLButtonElement;
  ensHistoryLink: HTMLAnchorElement;
  menuBtn: HTMLButtonElement;
  menu: HTMLDivElement;
  copyItem: HTMLButtonElement;
  ethLimoItem: HTMLButtonElement;
  hideItem: HTMLButtonElement;
  settingsItem: HTMLButtonElement;
  copyToast: HTMLSpanElement;
  updateStrip: HTMLDivElement;
  updateReloadBtn: HTMLButtonElement;
  updateDismissBtn: HTMLButtonElement;
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
    "display:block",
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
      all: unset;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 4px;
      background: #18181b; border: 1px solid #27272a;
      flex: none;
      transition: background-color 150ms, border-color 150ms;
    }
    .brand-mark:hover { background: #27272a; border-color: #3f3f46; }
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
    .star-btn {
      all: unset;
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 4px;
      color: #71717a; cursor: pointer; flex: none;
      transition: color 150ms, background-color 150ms;
    }
    .star-btn:hover { background: #27272a; color: #e4e4e7; }
    .star-btn svg { width: 14px; height: 14px; display: block; }
    .star-btn.favorited { color: #fbbf24; }
    .star-btn.favorited:hover { color: #fcd34d; }
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
    .bookmarks-btn,
    .ens-history-link {
      all: unset;
      display: inline-flex; align-items: center;
      height: 22px; padding: 0 10px; border-radius: 4px;
      color: #a1a1aa; cursor: pointer;
      font: 500 11px/1 inherit;
      transition: background-color 150ms, color 150ms;
      text-decoration: none;
    }
    .bookmarks-btn:hover,
    .ens-history-link:hover { background: #27272a; color: #f4f4f5; }
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
      display: flex; align-items: center; gap: 10px;
      width: 100%; box-sizing: border-box;
      padding: 7px 10px; border-radius: 4px;
      font: 500 12px/1.3 inherit; color: #e4e4e7; cursor: pointer;
      text-align: left;
      transition: background-color 150ms, color 150ms;
    }
    .menu button:hover { background: #27272a; color: #f4f4f5; }
    .menu button svg {
      width: 14px; height: 14px; flex: none; display: block;
      color: #a1a1aa;
      transition: color 150ms;
    }
    .menu button:hover svg { color: #e4e4e7; }
    .toast {
      display: none;
      color: #6ee7b7; font-weight: 500;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .toast.show { display: inline; }
    .update {
      display: none;
      align-items: center; gap: 10px;
      height: ${UPDATE_STRIP_PX}px; padding: 0 12px;
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      color: #fef3c7;
      background: #1a1207;
      border-bottom: 1px solid #422006;
    }
    .update.show { display: flex; }
    .update .update-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #fbbf24; flex: none;
    }
    .update .update-text {
      flex: 1 1 auto; min-width: 0;
      color: #fef3c7;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .update .update-text strong {
      color: #fde68a; font-weight: 600;
    }
    .update .update-actions {
      display: inline-flex; align-items: center; gap: 6px; flex: none;
    }
    .update button {
      all: unset;
      display: inline-flex; align-items: center; justify-content: center;
      height: 22px; padding: 0 10px; border-radius: 4px;
      font: 600 11px/1 inherit;
      cursor: pointer;
      transition: background-color 150ms, color 150ms, border-color 150ms;
    }
    .update button.reload {
      color: #09090b; background: #fbbf24;
    }
    .update button.reload:hover { background: #fcd34d; }
    .update button.dismiss {
      color: #fcd34d; background: transparent;
      border: 1px solid #422006;
    }
    .update button.dismiss:hover {
      background: #2a1a09; border-color: #78350f;
    }
  `;

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = `
    <span class="left">
      <button type="button" class="brand-mark" title="dapp3 home" aria-label="dapp3 home">
        <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M16 4 L8 17 L16 13 L24 17 Z" fill="#10b981"/>
          <path d="M16 28 L8 19 L16 15 L24 19 Z" fill="#059669"/>
        </svg>
      </button>
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
      <button class="star-btn" type="button" aria-label="favorite" title="Favorite this site">
        <svg class="star-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </button>
    </div>
    <span class="right">
      <span class="toast">copied</span>
      <a class="ens-history-link" target="_blank" rel="noopener noreferrer" title="View ENS History">View ENS History</a>
      <button class="bookmarks-btn" type="button" title="All Bookmarks">All Bookmarks</button>
      <span class="menu-wrap">
        <button class="menu-btn" type="button" aria-label="banner menu" title="Banner options">⋯</button>
        <div class="menu" role="menu">
          <button data-act="copy" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy underlying URL</span>
          </button>
          <button data-act="open-limo" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            <span>Open on eth.limo gateway</span>
          </button>
          <button data-act="hide" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
            <span>Hide banner for this session</span>
          </button>
          <button data-act="settings" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span>Open extension settings</span>
          </button>
        </div>
      </span>
    </span>
  `;

  const updateStrip = document.createElement("div");
  updateStrip.className = "update";
  updateStrip.innerHTML = `
    <span class="update-dot" aria-hidden="true"></span>
    <span class="update-text">
      <strong>Updated content available.</strong>
      The verified contenthash for this name has changed since this page loaded.
    </span>
    <span class="update-actions">
      <button class="reload" type="button" data-act="reload">Reload</button>
      <button class="dismiss" type="button" data-act="dismiss" aria-label="dismiss">Dismiss</button>
    </span>
  `;

  shadow.append(style, bar, updateStrip);

  const q = <T extends Element>(sel: string) =>
    shadow.querySelector(sel) as T;

  return {
    host,
    shadow,
    brandBtn: q<HTMLButtonElement>(".brand-mark"),
    dot: q<HTMLSpanElement>(".dot"),
    statusWrap: q<HTMLSpanElement>(".status"),
    stateText: q<HTMLSpanElement>(".statelabel"),
    urlForm: q<HTMLElement>(".identity"),
    urlInput: q<HTMLElement>(".urlfield"),
    starBtn: q<HTMLButtonElement>(".star-btn"),
    bookmarksBtn: q<HTMLButtonElement>(".bookmarks-btn"),
    ensHistoryLink: q<HTMLAnchorElement>(".ens-history-link"),
    menuBtn: q<HTMLButtonElement>(".menu-btn"),
    menu: q<HTMLDivElement>(".menu"),
    copyItem: q<HTMLButtonElement>('button[data-act="copy"]'),
    ethLimoItem: q<HTMLButtonElement>('button[data-act="open-limo"]'),
    hideItem: q<HTMLButtonElement>('button[data-act="hide"]'),
    settingsItem: q<HTMLButtonElement>('button[data-act="settings"]'),
    copyToast: q<HTMLSpanElement>(".toast"),
    updateStrip,
    updateReloadBtn: q<HTMLButtonElement>('.update button[data-act="reload"]'),
    updateDismissBtn: q<HTMLButtonElement>('.update button[data-act="dismiss"]'),
  };
}

function applyBodyOffset(target = HEIGHT_PX) {
  const apply = () => {
    if (!document.body) return false;
    const cur = parseFloat(getComputedStyle(document.body).marginTop) || 0;
    document.body.style.marginTop = `${Math.max(cur, target)}px`;
    // NOTE: do NOT set transform on <body> to "contain" page-level fixed
    // headers. A transform on <body> makes it the containing block for *all*
    // position:fixed descendants, which breaks dapp wallet-connect modals
    // (RainbowKit, ConnectKit, Web3Modal) that expect viewport anchoring and
    // end up clipped by the body offset. We handle viewport-anchored navs
    // with a per-element shifter (setupFixedNavOffset) instead, which uses
    // a size heuristic to skip modal overlays.
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

// Shift the site's own top-anchored nav bars down by the banner height so they
// aren't hidden underneath us. Body margin-top (applyBodyOffset) handles static
// content but does nothing for position:fixed / position:sticky elements that
// anchor to the viewport's top:0 — this walks those out of the way.
//
// Heuristic to distinguish a navbar from a modal overlay (since we can't shift
// modals without breaking them):
//   - position: fixed or sticky
//   - computed top in [-4, 8]px (close enough to the viewport top)
//   - width ≥ 50% viewport (navbars span the page; drawers/toasts don't)
//   - height ≤ 70% viewport (modals are full-height; navbars are strips)
//
// The manager is re-entrant: setHeight() updates all already-shifted elements,
// so toggling the update strip (44 → 76px) doesn't require a re-scan.
type FixedNavOffsetMgr = {
  setHeight: (px: number) => void;
  teardown: () => void;
};

function setupFixedNavOffset(): FixedNavOffsetMgr {
  const SHIFTED_ATTR = "data-dapp3-shifted";
  const ORIG_TOP_ATTR = "data-dapp3-original-top";
  let currentOffset = 0;
  let scanPending = false;

  const candidateTop = (el: HTMLElement, vw: number, vh: number): number | null => {
    if (el.id === BANNER_ID) return null;
    if (el === document.body || el === document.documentElement) return null;

    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return null;

    const topPx = parseFloat(cs.top);
    if (!Number.isFinite(topPx)) return null;
    if (topPx < -4 || topPx > 8) return null;

    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return null;
    // Modal-size guard: anything near viewport-height is almost certainly an
    // overlay/backdrop, not a navbar. Shifting those would break the overlay.
    if (rect.height / vh > 0.7) return null;
    // Narrow elements (drawers, toasts, FABs) don't belong to the top strip.
    if (rect.width / vw < 0.5) return null;

    return topPx;
  };

  const scan = () => {
    if (!document.body) return;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const all = document.body.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as HTMLElement;
      if (el.hasAttribute(SHIFTED_ATTR)) continue;
      const topPx = candidateTop(el, vw, vh);
      if (topPx === null) continue;
      el.setAttribute(ORIG_TOP_ATTR, String(topPx));
      el.setAttribute(SHIFTED_ATTR, "");
      el.style.setProperty("top", `${topPx + currentOffset}px`, "important");
    }
  };

  const scheduleScan = () => {
    if (scanPending) return;
    scanPending = true;
    requestAnimationFrame(() => {
      scanPending = false;
      scan();
    });
  };

  const reapplyOffsets = () => {
    const list = document.querySelectorAll<HTMLElement>(`[${SHIFTED_ATTR}]`);
    list.forEach((el) => {
      const orig = parseFloat(el.getAttribute(ORIG_TOP_ATTR) || "0");
      el.style.setProperty("top", `${orig + currentOffset}px`, "important");
    });
  };

  let obs: MutationObserver | null = null;
  let bodyWaiter: MutationObserver | null = null;
  let tornDown = false;

  const start = () => {
    // Subtree + childList catches late-rendered navs (SPA hydration, portals).
    // We also watch `class` because many nav components toggle a "scrolled"
    // class that flips position:relative → position:fixed. rAF coalescing
    // keeps the scan cost bounded even when the site thrashes class names.
    obs = new MutationObserver(() => scheduleScan());
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", scheduleScan);
    scheduleScan();
  };

  if (document.body) {
    start();
  } else {
    bodyWaiter = new MutationObserver(() => {
      if (document.body) {
        bodyWaiter?.disconnect();
        bodyWaiter = null;
        start();
      }
    });
    bodyWaiter.observe(document.documentElement, { childList: true });
  }

  return {
    setHeight(px) {
      if (currentOffset === px) return;
      currentOffset = px;
      reapplyOffsets();
      scheduleScan();
    },
    teardown() {
      if (tornDown) return;
      tornDown = true;
      obs?.disconnect();
      bodyWaiter?.disconnect();
      window.removeEventListener("resize", scheduleScan);
      document
        .querySelectorAll<HTMLElement>(`[${SHIFTED_ATTR}]`)
        .forEach((el) => {
          el.style.removeProperty("top");
          el.removeAttribute(SHIFTED_ATTR);
          el.removeAttribute(ORIG_TOP_ATTR);
        });
    },
  };
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

function scrapePageMetadata(): {
  title?: string;
  favicon?: string;
  description?: string;
} {
  const title = document.title?.trim() || undefined;

  // Prefer explicit rel="icon" variants over the implicit /favicon.ico fallback
  // so sites that do set a proper icon get it captured, not a 404.
  const iconSelectors = [
    'link[rel~="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
  ];
  let favicon: string | undefined;
  for (const sel of iconSelectors) {
    const el = document.querySelector(sel) as HTMLLinkElement | null;
    const href = el?.getAttribute("href");
    if (href) {
      try {
        favicon = new URL(href, location.href).toString();
        break;
      } catch {
        // malformed href; skip
      }
    }
  }

  const ogDesc = document
    .querySelector('meta[property="og:description"]')
    ?.getAttribute("content")
    ?.trim();
  const metaDesc = document
    .querySelector('meta[name="description"]')
    ?.getAttribute("content")
    ?.trim();
  const description = ogDesc || metaDesc || undefined;

  return { title, favicon, description };
}

function applyStarState(refs: Refs, favorited: boolean) {
  if (favorited) {
    refs.starBtn.classList.add("favorited");
    refs.starBtn.setAttribute("title", "Remove from favorites");
    refs.starBtn.setAttribute("aria-pressed", "true");
    const svg = refs.starBtn.querySelector("svg");
    svg?.setAttribute("fill", "currentColor");
  } else {
    refs.starBtn.classList.remove("favorited");
    refs.starBtn.setAttribute("title", "Favorite this site");
    refs.starBtn.setAttribute("aria-pressed", "false");
    const svg = refs.starBtn.querySelector("svg");
    svg?.setAttribute("fill", "none");
  }
}

function wireStar(refs: Refs, ctx: TabContext) {
  const name = ctx.ensName.toLowerCase();
  // Bookmarks are keyed by `name + path`, so `vitalik.eth/page1` and
  // `vitalik.eth/page2` stay distinct. The live path comes from location,
  // so SPA navigations update which bookmark we're comparing against.
  const livePath = () => normalizePath(currentPath() || "/");

  const refresh = async () => {
    const fav = await isBookmarked(name, livePath());
    applyStarState(refs, fav);
  };
  refresh();

  refs.starBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const path = livePath();
    const favorited = refs.starBtn.classList.contains("favorited");
    if (favorited) {
      await removeBookmark(name, path);
    } else {
      const meta = scrapePageMetadata();
      const entry: Bookmark = {
        ensName: name,
        path,
        title: meta.title,
        favicon: meta.favicon,
        description: meta.description,
        addedAt: Date.now(),
      };
      await addBookmark(entry);
    }
  });

  // Keep the star in sync if the user toggles from another tab, the
  // bookmarks page, or SPA-navigates to a different in-site URL.
  onBookmarksChanged((list) => {
    const path = livePath();
    const fav = list.some((b) => b.ensName === name && b.path === path);
    applyStarState(refs, fav);
  });
  wireSpaNav(() => {
    refresh();
  });
}

function wireMenu(refs: Refs, ctx: TabContext) {
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

  // Web3 (ERC-4804) dapps don't have an eth.limo equivalent — eth.limo only
  // serves IPFS contenthashes. Swap the menu item to point at w3eth.io, the
  // public ERC-4804 gateway, and route the click through the SW so it can
  // install the per-tab bypass before the navigation fires.
  const isWeb3 = ctx.kind === "web3" && !!ctx.contractAddress;
  if (isWeb3) {
    const label = refs.ethLimoItem.querySelector("span");
    if (label) label.textContent = "Open on w3eth.io";
  }
  refs.ethLimoItem.addEventListener("click", () => {
    close();
    const p = currentPath() || "/";
    const path = p.startsWith("/") ? p : `/${p}`;
    if (isWeb3 && ctx.contractAddress) {
      const url = `https://${ctx.contractAddress}.w3eth.io${path}`;
      chrome.runtime
        .sendMessage({ type: "open-on-w3eth", url })
        .then((resp) => {
          // SW responded but reported failure (rule install, tabs.update, etc).
          // Fall back to a direct navigation so the click still does
          // *something* visible. The bypass is gated by the SW so without it
          // the JS redirect handler may bounce us back to local — a degraded
          // UX but better than a dead button.
          if (!resp?.ok) location.assign(url);
        })
        .catch(() => location.assign(url));
      return;
    }
    // `ensName` already ends in `.eth`, so `<ensName>.limo` yields the public
    // gateway hostname. Preserve the live in-page path so deep links survive
    // the handoff — the user may have navigated within a SPA since mount.
    const url = `https://${ctx.ensName}.limo${path}`;
    chrome.runtime.sendMessage({ type: "open-on-eth-limo", url }).catch(() => {
      // SW unreachable — fall back to a direct navigation. If eth.limo
      // interception is on, DNR will yank this right back to local; that's
      // a degraded UX but better than a dead menu item.
      location.assign(url);
    });
  });

  refs.bookmarksBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
    chrome.runtime.sendMessage({ type: "open-bookmarks" }).catch(() => {
      // best-effort; the SW might not handle it, that's fine
    });
  });

  refs.brandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
    chrome.runtime.sendMessage({ type: "open-home" }).catch(() => {
      // best-effort; the SW might not handle it, that's fine
    });
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

  // Address-mode navigations (0x<addr>.w3eth.io intercept, homepage 0x input)
  // carry the contract address as `ensName`. There is no associated ENS name,
  // so the history link has nothing to point at.
  const isAddressNav = /^0x[a-f0-9]{40}$/i.test(ctx.ensName);
  if (isAddressNav) {
    refs.ensHistoryLink.style.display = "none";
  } else {
    refs.ensHistoryLink.href = `https://ens.eth.sh/history/${ctx.ensName.toLowerCase()}`;
  }

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
  const navOffset = setupFixedNavOffset();
  applyBodyOffset();
  navOffset.setHeight(HEIGHT_PX);

  wireSpaNav(render);
  wireMenu(refs, ctx);
  wireStar(refs, ctx);

  // "Hide for this session" escape hatch: if the nav-shift heuristic misjudges
  // something on a given site, the user can yank the banner entirely until
  // reload. We tear down DOM mutations we caused (body margin, shifted navs)
  // so the page looks exactly like it would without the extension injected.
  // The Helios polling loop self-exits once the banner element is gone.
  refs.hideItem.addEventListener("click", () => {
    refs.menu.classList.remove("open");
    navOffset.teardown();
    if (document.body) document.body.style.marginTop = "";
    refs.host.remove();
  });

  let pendingUpdateUrl: string | null = null;
  const showUpdateStrip = (gatewayUrl: string) => {
    pendingUpdateUrl = gatewayUrl;
    refs.updateStrip.classList.add("show");
    refs.host.style.height = `${HEIGHT_PX + UPDATE_STRIP_PX}px`;
    applyBodyOffset(HEIGHT_PX + UPDATE_STRIP_PX);
    navOffset.setHeight(HEIGHT_PX + UPDATE_STRIP_PX);
  };
  const hideUpdateStrip = () => {
    pendingUpdateUrl = null;
    refs.updateStrip.classList.remove("show");
    refs.host.style.height = `${HEIGHT_PX}px`;
    // Body margin only ever grows; no need to shrink it on dismiss — leaving
    // the extra 32px in place is less jarring than the page contents jumping.
  };
  refs.updateReloadBtn.addEventListener("click", () => {
    if (pendingUpdateUrl) location.assign(pendingUpdateUrl);
  });
  refs.updateDismissBtn.addEventListener("click", hideUpdateStrip);

  chrome.runtime.onMessage.addListener((msg: ContentUpdatedMessage) => {
    if (msg?.type !== "content-updated") return;
    if (msg.ensName.toLowerCase() !== ctx.ensName.toLowerCase()) return;
    // Preserve the user's current in-page path/search/hash on the reload, not
    // the path that was on the URL at initial navigation. The SW's gatewayUrl
    // was built from the initial path; rebuild for the live location.
    const u = new URL(msg.gatewayUrl);
    u.pathname = location.pathname;
    u.search = location.search;
    u.hash = location.hash;
    showUpdateStrip(u.toString());
  });

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
