import type { TabContext } from "@/lib/messaging";
import type { HeliosStatus } from "@/lib/helios-bridge";

const BANNER_ID = "local-eth-limo-banner";
const HEIGHT_PX = 36;
const POLL_MS = 2000;
const DISABLED_KEY = `leLimoBannerDisabled:${location.origin}`;

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

async function isDisabledForOrigin(): Promise<boolean> {
  const res = await chrome.storage.local.get(DISABLED_KEY);
  return !!res[DISABLED_KEY];
}

async function setDisabledForOrigin(): Promise<void> {
  await chrome.storage.local.set({ [DISABLED_KEY]: true });
}

type Dot = "ok" | "syncing" | "warn";

function pickDot(ctx: TabContext, status: HeliosStatus | null): {
  dot: Dot;
  label: string;
  title: string;
} {
  if (ctx.trustedDirectly) {
    return {
      dot: "warn",
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
  dot: HTMLSpanElement;
  stateText: HTMLSpanElement;
  name: HTMLSpanElement;
  path: HTMLSpanElement;
  menuBtn: HTMLButtonElement;
  menu: HTMLDivElement;
  copyItem: HTMLButtonElement;
  disableItem: HTMLButtonElement;
  settingsItem: HTMLButtonElement;
  copyToast: HTMLSpanElement;
};

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
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0f19; color: #e6edf3;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 1px 2px rgba(0,0,0,0.25);
    }
    .status { display: inline-flex; align-items: center; gap: 6px; color: #e6edf3; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; flex: none; }
    .dot.ok { background: #10b981; box-shadow: 0 0 0 2px rgba(16,185,129,0.18); }
    .dot.syncing {
      background: #f59e0b;
      box-shadow: 0 0 0 2px rgba(245,158,11,0.18);
      animation: pulse 1.4s ease-in-out infinite;
    }
    .dot.warn { background: #ef4444; box-shadow: 0 0 0 2px rgba(239,68,68,0.18); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .statelabel { color: #9aa7b8; font-weight: 500; }
    .left, .right {
      display: inline-flex; align-items: center; gap: 10px;
      flex: 1 1 0; min-width: 0;
    }
    .right { justify-content: flex-end; }
    .identity {
      display: inline-flex; align-items: baseline; gap: 0;
      flex: 0 1 auto; min-width: 0; max-width: 60%;
      overflow: hidden; justify-content: center;
      padding: 0 16px;
    }
    .name {
      font-weight: 700; color: #ffffff;
      white-space: nowrap;
    }
    .path {
      color: #9aa7b8; font-weight: 400;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      min-width: 0;
    }
    .menu-wrap { position: relative; }
    .menu-btn {
      all: unset;
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border-radius: 4px;
      color: #e6edf3; cursor: pointer;
      font-size: 16px; line-height: 1;
    }
    .menu-btn:hover { background: rgba(255,255,255,0.08); }
    .menu {
      position: absolute; top: calc(100% + 4px); right: 0;
      display: none; min-width: 220px;
      background: #0f1524; color: #e6edf3;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px; padding: 4px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .menu.open { display: block; }
    .menu button {
      all: unset;
      display: block; width: 100%; box-sizing: border-box;
      padding: 7px 10px; border-radius: 4px;
      font: 500 12px/1 inherit; color: #e6edf3; cursor: pointer;
      text-align: left;
    }
    .menu button:hover { background: rgba(255,255,255,0.08); }
    .toast {
      display: none;
      color: #10b981; font-weight: 500;
    }
    .toast.show { display: inline; }
  `;

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = `
    <span class="left">
      <span class="status">
        <span class="dot"></span>
        <span class="statelabel"></span>
      </span>
    </span>
    <span class="identity">
      <span class="name"></span><span class="path"></span>
    </span>
    <span class="right">
      <span class="toast">copied</span>
      <span class="menu-wrap">
        <button class="menu-btn" type="button" aria-label="banner menu" title="Banner options">⋯</button>
        <div class="menu" role="menu">
          <button data-act="copy" type="button">Copy underlying URL</button>
          <button data-act="disable" type="button">Hide banner on this origin</button>
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
    dot: q<HTMLSpanElement>(".dot"),
    stateText: q<HTMLSpanElement>(".statelabel"),
    name: q<HTMLSpanElement>(".name"),
    path: q<HTMLSpanElement>(".path"),
    menuBtn: q<HTMLButtonElement>(".menu-btn"),
    menu: q<HTMLDivElement>(".menu"),
    copyItem: q<HTMLButtonElement>('button[data-act="copy"]'),
    disableItem: q<HTMLButtonElement>('button[data-act="disable"]'),
    settingsItem: q<HTMLButtonElement>('button[data-act="settings"]'),
    copyToast: q<HTMLSpanElement>(".toast"),
  };
}

function applyBodyOffset() {
  const apply = () => {
    if (!document.body) return;
    const cur = parseFloat(getComputedStyle(document.body).marginTop) || 0;
    document.body.style.marginTop = `${Math.max(cur, HEIGHT_PX)}px`;
  };
  if (document.body) apply();
  else document.addEventListener("DOMContentLoaded", apply, { once: true });
}

function revertBodyOffset() {
  if (!document.body) return;
  const cur = parseFloat(getComputedStyle(document.body).marginTop) || 0;
  if (cur === HEIGHT_PX) document.body.style.marginTop = "";
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

function wireMenu(refs: Refs, onDisable: () => void) {
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

  refs.disableItem.addEventListener("click", async () => {
    close();
    await setDisabledForOrigin();
    onDisable();
  });

  refs.settingsItem.addEventListener("click", () => {
    close();
    chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {
      // best-effort; the SW might not handle it, that's fine
    });
  });
}

async function mount(ctx: TabContext) {
  if (document.getElementById(BANNER_ID)) return;

  const refs = buildBanner();
  (document.documentElement || document.body).appendChild(refs.host);

  let currentStatus: HeliosStatus | null = null;

  const render = () => {
    const { dot, label, title } = pickDot(ctx, currentStatus);
    refs.dot.classList.remove("ok", "syncing", "warn");
    refs.dot.classList.add(dot);
    refs.dot.title = title;
    refs.stateText.textContent = label;
    refs.stateText.title = title;

    refs.name.textContent = ctx.ensName;
    refs.path.textContent = currentPath();
  };

  render();
  applyBodyOffset();

  wireSpaNav(render);
  wireMenu(refs, () => {
    refs.host.remove();
    revertBodyOffset();
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
  if (await isDisabledForOrigin()) return;
  const ctx = await getCtx();
  if (!ctx) return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount(ctx), {
      once: true,
    });
  } else {
    mount(ctx);
  }
})();
