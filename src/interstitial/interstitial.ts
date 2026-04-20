import type { HeliosStatus } from "@/lib/helios-bridge";
import { colorize } from "@/lib/url-field";

// DNR redirects `http://foo.eth/path?q#h` → `<ext>/interstitial.html#<full-url>`.
// The original URL is stashed in the fragment verbatim — fragments can contain
// arbitrary characters, so no encoding is needed. Legacy query-param form
// (?name=&path=…) is kept as a fallback for manual/programmatic navigations.
function parseTarget(): {
  ensName: string;
  path: string;
  search: string;
  hash: string;
} {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (raw) {
    try {
      const u = new URL(raw);
      return {
        ensName: u.hostname.replace(/\.$/, "").toLowerCase(),
        path: u.pathname || "/",
        search: u.search,
        hash: u.hash,
      };
    } catch {
      /* fall through to query-string form */
    }
  }
  const p = new URLSearchParams(location.search);
  return {
    ensName: (p.get("name") ?? "").toLowerCase(),
    path: p.get("path") ?? "/",
    search: p.get("search") ?? "",
    hash: p.get("hash") ?? "",
  };
}

const { ensName, path, search, hash } = parseTarget();

document.title = ensName ? `resolving ${ensName}…` : "dapp3";

const nameEl = document.getElementById("name") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const barEl = document.getElementById("bar") as HTMLDivElement;
const loaderEl = document.getElementById("loader") as HTMLDivElement;
const bypassBtn = document.getElementById("bypass") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;
const statusBadgeEl = document.getElementById("statusBadge") as HTMLSpanElement;
const statusDotEl = document.getElementById("statusDot") as HTMLSpanElement;
const statusLabelEl = document.getElementById("statusLabel") as HTMLSpanElement;
const stageSubEl = document.getElementById("stageSub") as HTMLParagraphElement;
const errorCardEl = document.getElementById("errorCard") as HTMLDivElement;
const errorDetailEl = document.getElementById("errorDetail") as HTMLPreElement;
const ethlimoFallbackEl = document.getElementById(
  "ethlimoFallback",
) as HTMLAnchorElement;

// Mechanically derive `<name>.eth.limo` from the ENS target so the user has a
// way out if Helios sync or the local resolve never succeeds. Only shown on a
// real error state — we don't want to nudge users off our path during normal
// "still syncing" waits.
function ethLimoFallbackUrl(): string | null {
  if (!/^(?:[a-z0-9-]+\.)+eth$/.test(ensName)) return null;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `https://${ensName}.limo${p}${search}${hash}`;
}

function showError(detail: string) {
  errorDetailEl.textContent = detail;
  errorCardEl.hidden = false;
  stageSubEl.hidden = true;
  const fb = ethLimoFallbackUrl();
  if (fb) {
    ethlimoFallbackEl.href = fb;
    ethlimoFallbackEl.hidden = false;
  }
}

function clearError() {
  errorCardEl.hidden = true;
  stageSubEl.hidden = false;
  ethlimoFallbackEl.hidden = true;
}

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
  colorize(nameEl, `${ensName}${displayPath}`);
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
    : "Fetching ENS contenthash…";
  setBar("loading");
  const resp = await chrome.runtime.sendMessage({
    type: "interstitial-retry",
    name: ensName,
    path,
    search,
    hash,
    bypassHelios,
  });
  if (!resp?.ok) {
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
cancelBtn.addEventListener("click", () => {
  polling = false;
  history.back();
});

(async () => {
  if (await tryCache()) return;
  pollLoop();
})();
