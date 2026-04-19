import type { HeliosStatus } from "@/lib/helios-bridge";
import { getSettings } from "@/lib/settings";

const ipfsEl = document.getElementById("ipfs-status") as HTMLSpanElement;
const heliosEl = document.getElementById("helios-status") as HTMLSpanElement;

async function probeIpfs() {
  try {
    await fetch("http://bafkqaaa.ipfs.localhost:8080/", {
      mode: "no-cors",
      signal: AbortSignal.timeout(1500),
    });
    ipfsEl.textContent = "online";
    ipfsEl.classList.add("ok");
  } catch {
    ipfsEl.textContent = "offline";
    ipfsEl.classList.add("bad");
  }
}

function renderHelios(status: HeliosStatus | null) {
  heliosEl.classList.remove("ok", "bad");
  if (!status) {
    heliosEl.textContent = "unknown";
    return;
  }
  switch (status.state) {
    case "idle":
      heliosEl.textContent = "not started";
      break;
    case "booting":
      heliosEl.textContent = "booting…";
      break;
    case "syncing":
      heliosEl.textContent = "syncing…";
      break;
    case "synced":
      heliosEl.textContent = "online";
      heliosEl.classList.add("ok");
      break;
    case "error":
      heliosEl.textContent = `error: ${status.error ?? "unknown"}`;
      heliosEl.classList.add("bad");
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
    !s.onboardingComplete && s.rpcUrls.length === 0
      ? chrome.runtime.getURL("src/onboarding/onboarding.html")
      : chrome.runtime.getURL("src/options/options.html");
  await chrome.tabs.create({ url });
  window.close();
});

probeIpfs();
pollHelios();
