import type { HeliosStatus } from "@/lib/helios-bridge";

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

const titleEl = document.getElementById("title") as HTMLHeadingElement;
const nameEl = document.getElementById("name") as HTMLParagraphElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const spinnerEl = document.querySelector(".spinner") as HTMLDivElement;
const bypassBtn = document.getElementById("bypass") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;

nameEl.textContent = ensName || "(no name)";

let polling = true;

function setSpinner(kind: "spinning" | "ok" | "bad") {
  spinnerEl.classList.remove("ok", "bad");
  if (kind !== "spinning") spinnerEl.classList.add(kind);
}

function describeStatus(s: HeliosStatus): string {
  switch (s.state) {
    case "idle":
      return "Helios is not yet running.";
    case "booting":
      return "Starting Helios…";
    case "syncing":
      return "Syncing with Ethereum consensus layer…";
    case "synced":
      return "Synced. Resolving…";
    case "error":
      return `Helios error: ${s.error ?? "unknown"}`;
  }
}

async function triggerResolve(bypassHelios = false) {
  polling = false;
  titleEl.textContent = bypassHelios ? "Resolving via RPC…" : "Resolving…";
  statusEl.textContent = bypassHelios
    ? "Skipping Helios for this one resolution."
    : "Helios synced — fetching ENS contenthash…";
  setSpinner("spinning");
  const resp = await chrome.runtime.sendMessage({
    type: "interstitial-retry",
    name: ensName,
    path,
    search,
    hash,
    bypassHelios,
  });
  if (!resp?.ok) {
    titleEl.textContent = "Failed";
    statusEl.textContent = resp?.error ?? "Unknown error";
    setSpinner("bad");
  }
  // On success, the SW has called chrome.tabs.update and this page is replaced.
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
        if (status.state === "synced") {
          await triggerResolve(false);
          return;
        }
        if (status.state === "error") {
          setSpinner("bad");
        }
      }
    } catch (e) {
      statusEl.textContent = `Status check failed: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

bypassBtn.addEventListener("click", () => triggerResolve(true));
cancelBtn.addEventListener("click", () => {
  polling = false;
  history.back();
});

pollLoop();
