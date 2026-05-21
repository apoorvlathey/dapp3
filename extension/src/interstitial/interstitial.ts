import {
  addBookmark,
  isBookmarked,
  normalizePath,
  onBookmarksChanged,
  removeBookmark,
  type Bookmark,
} from "@/lib/bookmarks";
import type { HeliosStatus } from "@/lib/helios-bridge";
import { colorize } from "@/lib/url-field";
import { probeKuboApi, getKuboApiBase, setKuboApiConfig } from "@/lib/kubo";
import { getSettings } from "@/lib/settings";
import { colorizeJson } from "@/lib/colorize-json";

// DNR redirects `http://foo.eth/path?q#h` → `<ext>/interstitial.html#<full-url>`.
// The original URL is stashed in the fragment verbatim — fragments can contain
// arbitrary characters, so no encoding is needed. Legacy query-param form
// (?name=&path=…) is kept as a fallback for manual/programmatic navigations.
//
// `ensName` is the resolution target — either a `.eth` name (ENS mode) or a
// `0x<40hex>` contract address (w3eth.io / homepage address mode). The SW
// dispatches based on the format. `mode` is exposed for UI affordances that
// only make sense in one mode (ENS history link, eth.limo fallback, etc.).
type TargetMode = "ens" | "address";

function parseTarget(): {
  ensName: string;
  path: string;
  search: string;
  hash: string;
  mode: TargetMode;
} {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (raw) {
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/\.$/, "").toLowerCase();
      // w3eth.io subdomain is the contract address directly.
      const addrMatch = host.match(/^(0x[a-f0-9]{40})\.w3eth\.io$/i);
      if (addrMatch && addrMatch[1]) {
        return {
          ensName: addrMatch[1].toLowerCase(),
          path: u.pathname || "/",
          search: u.search,
          hash: u.hash,
          mode: "address",
        };
      }
      return {
        ensName: host,
        path: u.pathname || "/",
        search: u.search,
        hash: u.hash,
        mode: "ens",
      };
    } catch {
      /* fall through to query-string form */
    }
  }
  const p = new URLSearchParams(location.search);
  const name = (p.get("name") ?? "").toLowerCase();
  const mode: TargetMode = /^0x[a-f0-9]{40}$/i.test(name) ? "address" : "ens";
  return {
    ensName: name,
    path: p.get("path") ?? "/",
    search: p.get("search") ?? "",
    hash: p.get("hash") ?? "",
    mode,
  };
}

const { ensName, path, search, hash, mode } = parseTarget();
const isAddressMode = mode === "address";

document.title = ensName
  ? `resolving ${isAddressMode ? shortAddr(ensName) : ensName}…`
  : "dapp3.eth";

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

const nameEl = document.getElementById("name") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const barEl = document.getElementById("bar") as HTMLDivElement;
const loaderEl = document.getElementById("loader") as HTMLDivElement;
const bypassBtn = document.getElementById("bypass") as HTMLButtonElement;
const starBtn = document.getElementById("star") as HTMLButtonElement;
const statusBadgeEl = document.getElementById("statusBadge") as HTMLSpanElement;
const statusDotEl = document.getElementById("statusDot") as HTMLSpanElement;
const statusLabelEl = document.getElementById("statusLabel") as HTMLSpanElement;
const stageSubEl = document.getElementById("stageSub") as HTMLParagraphElement;
const errorCardEl = document.getElementById("errorCard") as HTMLDivElement;
const errorDetailEl = document.getElementById("errorDetail") as HTMLPreElement;
const ethlimoFallbackEl = document.getElementById(
  "ethlimoFallback",
) as HTMLAnchorElement;
const ensHistoryEl = document.getElementById(
  "ensHistory",
) as HTMLAnchorElement;
const setupCardEl = document.getElementById("setupCard") as HTMLDivElement;
const setupCmdEl = document.getElementById("setupCmd") as HTMLPreElement;
const setupJsonEl = document.getElementById("setupJson") as HTMLPreElement;
const setupRecheckBtn = document.getElementById(
  "setupRecheck",
) as HTMLButtonElement;
const setupStatusEl = document.getElementById("setupStatus") as HTMLDivElement;

if (!isAddressMode && ensName && /^(?:[a-z0-9-]+\.)+eth$/.test(ensName)) {
  ensHistoryEl.href = `https://ens.eth.sh/history/${ensName}`;
  ensHistoryEl.hidden = false;
}

// Mechanically derive a public-gateway fallback URL so the user has a way out
// if Helios sync or the local resolve never succeeds. ENS mode → `eth.limo`;
// address mode → `w3eth.io`. Only shown on a real error state — we don't want
// to nudge users off our path during normal "still syncing" waits.
function ethLimoFallbackUrl(): string | null {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (isAddressMode) {
    if (!/^0x[a-f0-9]{40}$/.test(ensName)) return null;
    return `https://${ensName}.w3eth.io${p}${search}${hash}`;
  }
  if (!/^(?:[a-z0-9-]+\.)+eth$/.test(ensName)) return null;
  return `https://${ensName}.limo${p}${search}${hash}`;
}

function showError(detail: string) {
  errorDetailEl.textContent = detail;
  errorCardEl.hidden = false;
  stageSubEl.hidden = true;
  const fb = ethLimoFallbackUrl();
  if (fb) {
    ethlimoFallbackEl.href = fb;
    ethlimoFallbackEl.textContent = isAddressMode
      ? "Open on w3eth.io →"
      : "Open on eth.limo gateway →";
    ethlimoFallbackEl.hidden = false;
  }
}

function clearError() {
  errorCardEl.hidden = true;
  stageSubEl.hidden = false;
  ethlimoFallbackEl.hidden = true;
}

// Setup-card state (Kubo CORS not configured). The card replaces the loader
// + status text inline so the user keeps the address-bar context. Recheck
// re-runs probe + resolution; on success the SW redirects the tab to the
// gateway URL and this page is replaced.
const COMBINED_KUBO_CMD = (() => {
  const id = chrome.runtime.id;
  return `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["chrome-extension://${id}"]' && ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'`;
})();

setupCmdEl.textContent = COMBINED_KUBO_CMD;
setupJsonEl.innerHTML = colorizeJson(
  [
    `{`,
    `  ...`,
    `  "API": {`,
    `    "HTTPHeaders": {`,
    `      ...`,
    `      "Access-Control-Allow-Methods": ["POST"],`,
    `      "Access-Control-Allow-Origin": [`,
    `        ...,`,
    `        "chrome-extension://${chrome.runtime.id}"`,
    `      ]`,
    `    }`,
    `  },`,
    `  ...`,
    `}`,
  ].join("\n"),
);

function showSetupCard() {
  errorCardEl.hidden = true;
  ethlimoFallbackEl.hidden = true;
  stageSubEl.hidden = true;
  loaderEl.hidden = true;
  statusEl.textContent = "Kubo needs one-time setup";
  setupCardEl.hidden = false;
}

function hideSetupCard() {
  setupCardEl.hidden = true;
  loaderEl.hidden = false;
}

function setSetupStatus(tone: "ok" | "warn" | "bad", text: string) {
  setupStatusEl.hidden = false;
  setupStatusEl.classList.remove("ok", "warn", "bad");
  setupStatusEl.classList.add(tone);
  setupStatusEl.textContent = text;
}

function clearSetupStatus() {
  setupStatusEl.hidden = true;
  setupStatusEl.textContent = "";
  setupStatusEl.classList.remove("ok", "warn", "bad");
}

setupCardEl
  .querySelectorAll<HTMLButtonElement>(".setup-copy")
  .forEach((btn) => {
    const label = btn.querySelector<HTMLElement>(".setup-copy-label");
    btn.addEventListener("click", async () => {
      const target = btn.dataset.target;
      if (!target) return;
      const el = document.getElementById(target);
      const text = el?.textContent ?? "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        return;
      }
      btn.classList.add("copied");
      if (label) label.textContent = "Copied";
      setTimeout(() => {
        btn.classList.remove("copied");
        if (label) label.textContent = "Copy";
      }, 1500);
    });
  });

setupRecheckBtn.addEventListener("click", async () => {
  setupRecheckBtn.disabled = true;
  setSetupStatus("warn", "Probing Kubo API…");
  const probe = await probeKuboApi();
  if (!probe.ok) {
    setupRecheckBtn.disabled = false;
    if (probe.kind.kind === "cors") {
      setSetupStatus(
        "bad",
        "Kubo is still rejecting this extension's origin. Did the daemon restart?",
      );
    } else if (probe.kind.kind === "unreachable") {
      setSetupStatus(
        "bad",
        `Can't reach Kubo at ${getKuboApiBase()}. Is IPFS Desktop running? (${probe.kind.cause})`,
      );
    } else {
      setSetupStatus("bad", `Kubo returned an unexpected response: ${probe.kind.kind}.`);
    }
    return;
  }
  setSetupStatus("ok", "Kubo allowed the extension. Retrying…");
  // Hand off to the normal resolve path; on success the SW navigates the tab
  // to <cid>.ipfs.localhost. On any further failure, triggerResolve will
  // surface the error card or re-show this setup card.
  hideSetupCard();
  clearSetupStatus();
  await triggerResolve(false);
});

type BadgeTone = "ok" | "syncing" | "warn";

function setBadge(tone: BadgeTone, label: string, title: string) {
  statusBadgeEl.classList.remove("ok", "syncing", "warn");
  statusDotEl.classList.remove("ok", "syncing", "warn");
  statusBadgeEl.classList.add(tone);
  statusDotEl.classList.add(tone);
  statusLabelEl.textContent = label;
  statusBadgeEl.title = title;
}

function paintBadge(s: HeliosStatus | undefined) {
  if (!s) {
    setBadge("warn", "Helios offline", "Helios has not started yet.");
    return;
  }
  switch (s.state) {
    case "idle":
      setBadge("warn", "Helios offline", "Helios has not started yet.");
      return;
    case "booting":
      setBadge(
        "syncing",
        "Helios booting",
        "Helios is starting up against your execution RPC.",
      );
      return;
    case "syncing":
      setBadge(
        "syncing",
        "Helios syncing",
        "Helios is catching up to the chain tip.",
      );
      return;
    case "synced":
      setBadge(
        "ok",
        "Helios online",
        "Helios is in sync with Ethereum consensus and ready to verify.",
      );
      return;
    case "error":
      setBadge("warn", "Helios error", `Helios error: ${s.error ?? "unknown"}`);
      return;
  }
}

paintBadge(undefined);

const displayPath = `${path === "/" ? "" : path}${search}${hash}`;
if (ensName) {
  if (isAddressMode) {
    nameEl.textContent = "";
    const host = document.createElement("span");
    host.className = "u-host";
    host.textContent = ensName;
    host.title = ensName;
    nameEl.appendChild(host);
    if (displayPath) {
      const p = document.createElement("span");
      p.className = "u-path";
      p.textContent = displayPath;
      nameEl.appendChild(p);
    }
  } else {
    colorize(nameEl, `${ensName}${displayPath}`);
  }
} else {
  nameEl.textContent = "(no name)";
}

let polling = true;

// Fast path: if the SW has a cached resolution for this name, skip the Helios
// wait + resolve round-trip and jump straight to the gateway URL. The SW
// re-resolves in the background and the banner surfaces an "updated" notice
// if the contenthash has since changed.
async function tryCache(): Promise<boolean> {
  if (!ensName) return false;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "interstitial-cache-check",
      name: ensName,
      path,
      search,
      hash,
    });
    if (resp?.cached && typeof resp.gatewayUrl === "string") {
      polling = false;
      location.replace(resp.gatewayUrl);
      return true;
    }
  } catch {
    // SW unavailable or message failed — fall back to the Helios poll path.
  }
  return false;
}

function setBar(state: "loading" | "ok" | "bad") {
  barEl.classList.remove("ok", "bad");
  loaderEl.classList.remove("ok", "bad");
  if (state !== "loading") {
    barEl.classList.add(state);
    loaderEl.classList.add(state);
  }
}

function describeStatus(s: HeliosStatus): string {
  switch (s.state) {
    case "idle":
      return "Helios is not yet running.";
    case "booting":
      return "Starting Helios…";
    case "syncing":
      return "Syncing with Ethereum consensus…";
    case "synced":
      return "Synced. Resolving…";
    case "error":
      return "Helios sync failed";
  }
}

async function triggerResolve(bypassHelios = false) {
  polling = false;
  statusEl.textContent = bypassHelios
    ? "Resolving via RPC (skipping Helios)…"
    : isAddressMode
      ? "Fetching onchain HTML…"
      : "Fetching ENS contenthash…";
  setBar("loading");
  hideSetupCard();
  clearSetupStatus();
  const resp = await chrome.runtime.sendMessage({
    type: "interstitial-retry",
    name: ensName,
    path,
    search,
    hash,
    bypassHelios,
  });
  if (!resp?.ok) {
    // Kubo CORS rejection is a one-time setup issue, not a per-site failure.
    // Show the setup card inline (PRD_ERC4804.md §6.1) so the user keeps the
    // address-bar context instead of being bounced to a separate page.
    if (resp?.code === "kubo-cors-blocked") {
      showSetupCard();
      setBar("bad");
      return;
    }
    statusEl.textContent = "Resolution failed";
    showError(resp?.error ?? "Unknown error");
    setBar("bad");
  }
  // On success, the SW calls chrome.tabs.update and this page is replaced.
}

async function pollLoop() {
  while (polling) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "get-helios-status",
      });
      const status: HeliosStatus | undefined = resp?.status;
      if (status) {
        statusEl.textContent = describeStatus(status);
        paintBadge(status);
        if (status.state === "synced") {
          clearError();
          await triggerResolve(false);
          return;
        }
        if (status.state === "error") {
          setBar("bad");
          showError(status.error ?? "Unknown error");
        } else {
          clearError();
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      statusEl.textContent = "Status check failed";
      showError(msg);
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

bypassBtn.addEventListener("click", () => triggerResolve(true));

// Bookmark toggle for the current resolution target. The interstitial doesn't
// have page metadata (title/favicon/description) since the dapp hasn't loaded
// yet — the bookmark is stored as just name + path.
function applyStarState(favorited: boolean) {
  const svg = starBtn.querySelector("svg");
  if (favorited) {
    starBtn.classList.add("favorited");
    starBtn.setAttribute("title", "Remove from favorites");
    starBtn.setAttribute("aria-pressed", "true");
    svg?.setAttribute("fill", "currentColor");
  } else {
    starBtn.classList.remove("favorited");
    starBtn.setAttribute("title", "Favorite this site");
    starBtn.setAttribute("aria-pressed", "false");
    svg?.setAttribute("fill", "none");
  }
}

if (ensName && !isAddressMode) {
  const bookmarkPath = normalizePath(`${path}${search}${hash}` || "/");
  const refreshStar = async () => {
    applyStarState(await isBookmarked(ensName, bookmarkPath));
  };
  refreshStar();
  starBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (starBtn.classList.contains("favorited")) {
      await removeBookmark(ensName, bookmarkPath);
    } else {
      const entry: Bookmark = {
        ensName,
        path: bookmarkPath,
        addedAt: Date.now(),
      };
      await addBookmark(entry);
    }
  });
  onBookmarksChanged((list) => {
    const fav = list.some(
      (b) => b.ensName === ensName && b.path === bookmarkPath,
    );
    applyStarState(fav);
  });
} else {
  starBtn.hidden = true;
}

(async () => {
  const s = await getSettings();
  if (s.kuboApi) {
    setKuboApiConfig(s.kuboApi);
  }
  if (await tryCache()) return;
  pollLoop();
})();
