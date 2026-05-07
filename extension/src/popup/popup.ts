import type { HeliosStatus } from "@/lib/helios-bridge";
import { getSettings } from "@/lib/settings";

const ipfsEl = document.getElementById("ipfs-status") as HTMLSpanElement;
const ipfsDot = document.getElementById("ipfs-dot") as HTMLSpanElement;
const heliosEl = document.getElementById("helios-status") as HTMLSpanElement;
const heliosDot = document.getElementById("helios-dot") as HTMLSpanElement;
const heliosErrorCard = document.getElementById(
  "helios-error-card",
) as HTMLDivElement;
const heliosErrorDetail = document.getElementById(
  "helios-error-detail",
) as HTMLPreElement;

function setDot(dot: HTMLSpanElement, kind: "ok" | "bad" | "syncing" | "idle") {
  dot.classList.remove("ok", "bad", "syncing");
  if (kind !== "idle") dot.classList.add(kind);
}

function setStatus(el: HTMLSpanElement, kind: "ok" | "bad" | "idle") {
  el.classList.remove("ok", "bad");
  if (kind !== "idle") el.classList.add(kind);
}

async function probeIpfs() {
  try {
    await fetch("http://bafkqaaa.ipfs.localhost:8080/", {
      mode: "no-cors",
      // Gateway returns `Cache-Control: immutable, max-age=1y` for this CID,
      // so without `no-store` Chrome can serve a stale success long after
      // Kubo has been stopped.
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    ipfsEl.textContent = "online";
    setStatus(ipfsEl, "ok");
    setDot(ipfsDot, "ok");
  } catch {
    ipfsEl.textContent = "offline";
    setStatus(ipfsEl, "bad");
    setDot(ipfsDot, "bad");
  }
}

function showHeliosError(detail: string) {
  heliosErrorDetail.textContent = detail;
  heliosErrorCard.hidden = false;
}

function clearHeliosError() {
  heliosErrorCard.hidden = true;
}

function renderHelios(status: HeliosStatus | null) {
  setStatus(heliosEl, "idle");
  if (!status) {
    heliosEl.textContent = "unknown";
    setDot(heliosDot, "idle");
    clearHeliosError();
    return;
  }
  switch (status.state) {
    case "idle":
      heliosEl.textContent = "not started";
      setDot(heliosDot, "idle");
      clearHeliosError();
      break;
    case "booting":
      heliosEl.textContent = "booting…";
      setDot(heliosDot, "syncing");
      clearHeliosError();
      break;
    case "syncing":
      heliosEl.textContent = "syncing…";
      setDot(heliosDot, "syncing");
      clearHeliosError();
      break;
    case "synced":
      heliosEl.textContent = "online";
      setStatus(heliosEl, "ok");
      setDot(heliosDot, "ok");
      clearHeliosError();
      break;
    case "error":
      heliosEl.textContent = "error";
      setStatus(heliosEl, "bad");
      setDot(heliosDot, "bad");
      showHeliosError(status.error ?? "Unknown error");
      break;
  }
}

async function pollHelios() {
  while (true) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "get-helios-status",
      });
      renderHelios(resp?.status ?? null);
    } catch {
      renderHelios(null);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

document.getElementById("open-options")?.addEventListener("click", async () => {
  const s = await getSettings();
  const url =
    !s.onboardingComplete && !s.rpcUrl
      ? chrome.runtime.getURL("onboarding.html")
      : chrome.runtime.getURL("options.html");
  await chrome.tabs.create({ url });
  window.close();
});

document.getElementById("open-bookmarks")?.addEventListener("click", async () => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("bookmarks.html"),
  });
  window.close();
});

document.getElementById("open-home")?.addEventListener("click", async () => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("home.html"),
  });
  window.close();
});

// Fallback path for the narrow race where the SW hasn't yet applied
// `chrome.action.setPopup('')` after onboarding was reset (or on a fresh
// install before the initial getSettings() resolves): bounce to onboarding
// instead of showing a popup against an unconfigured extension.
async function bootPopup() {
  const s = await getSettings();
  if (!s.onboardingComplete) {
    const url = chrome.runtime.getURL("onboarding.html");
    const existing = await chrome.tabs.query({ url });
    const tab = existing[0];
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
    return;
  }
  probeIpfs();
  pollHelios();
}

bootPopup();
