import { getSettings, setSettings } from "@/lib/settings";
import type { HeliosStatus } from "@/lib/helios-bridge";

const DEFAULT_CONSENSUS_RPC = "https://ethereum-beacon-api.publicnode.com";

type StepId = 1 | 2 | 3 | 4;
let currentStep: StepId = 1;

const stepper = document.querySelector(".stepper") as HTMLElement;
const panels: Record<StepId, HTMLElement> = {
  1: document.querySelector<HTMLElement>('.step-panel[data-step="1"]')!,
  2: document.querySelector<HTMLElement>('.step-panel[data-step="2"]')!,
  3: document.querySelector<HTMLElement>('.step-panel[data-step="3"]')!,
  4: document.querySelector<HTMLElement>('.step-panel[data-step="4"]')!,
};

function showStep(s: StepId) {
  currentStep = s;
  for (const [k, el] of Object.entries(panels)) {
    el.hidden = Number(k) !== s;
  }
  for (const node of stepper.querySelectorAll<HTMLElement>(".step")) {
    const n = Number(node.dataset.step) as StepId;
    node.classList.remove("current", "done");
    if (n < s) node.classList.add("done");
    else if (n === s) node.classList.add("current");
  }
}

// --- Step 1: IPFS ---
const ipfsDot = document.getElementById("ipfs-dot") as HTMLSpanElement;
const ipfsText = document.getElementById("ipfs-status-text") as HTMLSpanElement;
const ipfsNext = document.getElementById("ipfs-next") as HTMLButtonElement;
const ipfsRecheck = document.getElementById("ipfs-recheck") as HTMLButtonElement;

async function probeIpfs(): Promise<boolean> {
  ipfsDot.classList.remove("ok", "bad");
  ipfsText.textContent = "checking Kubo gateway at 127.0.0.1:8080…";
  // Probe the subdomain gateway with the empty-UnixFS CID. `no-cors` means we
  // cannot read the response, but a resolved promise proves the port answered
  // — i.e. Kubo is up and serving subdomains on localhost:8080.
  try {
    await fetch("http://bafkqaaa.ipfs.localhost:8080/", {
      mode: "no-cors",
      signal: AbortSignal.timeout(2500),
    });
    ipfsDot.classList.add("ok");
    ipfsText.textContent = "online · gateway reachable at localhost:8080";
    ipfsNext.disabled = false;
    return true;
  } catch (e) {
    ipfsDot.classList.add("bad");
    ipfsText.textContent = `not reachable: ${e instanceof Error ? e.message : String(e)}`;
    ipfsNext.disabled = true;
    return false;
  }
}

ipfsRecheck.addEventListener("click", () => void probeIpfs());
ipfsNext.addEventListener("click", () => showStep(2));

// --- Step 2: RPC ---
const rpcForm = document.getElementById("rpc-form") as HTMLFormElement;
const rpcBack = document.getElementById("rpc-back") as HTMLButtonElement;
const permPreview = document.getElementById("perm-preview") as HTMLUListElement;
const rpcInput = rpcForm.elements.namedItem("url") as HTMLInputElement;

function renderPermPreview() {
  permPreview.innerHTML = "";
  const items: string[] = [];
  try {
    const u = new URL(rpcInput.value);
    items.push(`${u.origin}  (your execution RPC — reads Ethereum state)`);
  } catch {
    items.push("<your execution RPC, once entered above>");
  }
  items.push(
    `${new URL(DEFAULT_CONSENSUS_RPC).origin}  (Helios consensus RPC — reads beacon-chain light-client data)`,
  );
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    permPreview.appendChild(li);
  }
}

rpcInput.addEventListener("input", renderPermPreview);
renderPermPreview();

rpcBack.addEventListener("click", () => showStep(1));

rpcForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = String(new FormData(rpcForm).get("url") ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    alert("Not a valid URL.");
    return;
  }
  const cur = await getSettings();
  const consensus = cur.consensusRpc || DEFAULT_CONSENSUS_RPC;
  const origins = [`${parsed.origin}/*`];
  try {
    origins.push(new URL(consensus).origin + "/*");
  } catch {
    /* skip */
  }
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    alert(
      "Permission was not granted. The extension needs to reach both the execution RPC and the Helios consensus RPC.",
    );
    return;
  }
  const existing = cur.rpcUrls.filter((u) => u !== url);
  await setSettings({ rpcUrls: [url, ...existing] });
  showStep(3);
});

// --- Step 3: Advanced ---
const advForm = document.getElementById("advanced-form") as HTMLFormElement;
const advBack = document.getElementById("adv-back") as HTMLButtonElement;

advBack.addEventListener("click", () => showStep(2));

(async () => {
  const s = await getSettings();
  const consInput = advForm.elements.namedItem("consensusRpc") as HTMLInputElement;
  const ckptInput = advForm.elements.namedItem("checkpoint") as HTMLInputElement;
  consInput.value = s.consensusRpc ?? "";
  ckptInput.value = s.checkpoint ?? "";

  const chipsEl = document.getElementById("consensus-chips");
  if (chipsEl) {
    const alternatives = [
      "https://ethereum-beacon-api.publicnode.com",
      "https://eth-beacon-chain.drpc.org",
    ];
    for (const url of alternatives) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = new URL(url).host;
      chip.title = url;
      chip.addEventListener("click", () => {
        consInput.value = url;
        consInput.focus();
      });
      chipsEl.appendChild(chip);
    }
  }
})();

advForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(advForm);
  const consensusRpc = String(fd.get("consensusRpc") ?? "").trim() || undefined;
  let checkpoint = String(fd.get("checkpoint") ?? "").trim() || undefined;
  if (checkpoint && !checkpoint.startsWith("0x")) checkpoint = "0x" + checkpoint;

  const consensusToUse = consensusRpc || DEFAULT_CONSENSUS_RPC;
  try {
    const origin = new URL(consensusToUse).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        alert(
          "Consensus RPC permission not granted — Helios will not be able to sync.",
        );
        return;
      }
    }
  } catch {
    alert("Consensus RPC URL is not valid.");
    return;
  }

  await setSettings({ consensusRpc, checkpoint });
  showStep(4);
  void startHelios();
});

// --- Step 4: Helios sync ---
const heliosDot = document.getElementById("helios-dot") as HTMLSpanElement;
const heliosText = document.getElementById("helios-status-text") as HTMLSpanElement;
const finishBtn = document.getElementById("finish") as HTMLButtonElement;

function renderHelios(status: HeliosStatus | null) {
  heliosDot.classList.remove("ok", "bad");
  if (!status) {
    heliosText.textContent = "unknown";
    return;
  }
  switch (status.state) {
    case "idle":
      heliosText.textContent = "not yet started";
      break;
    case "booting":
      heliosText.textContent = "booting Helios WASM…";
      break;
    case "syncing":
      heliosText.textContent = "syncing with Ethereum consensus…";
      break;
    case "synced":
      heliosText.textContent = `synced · exec RPC ${status.executionRpc ?? "—"}`;
      heliosDot.classList.add("ok");
      finishBtn.disabled = false;
      break;
    case "error":
      heliosText.textContent = `error: ${status.error ?? "unknown"}`;
      heliosDot.classList.add("bad");
      break;
  }
}

async function startHelios() {
  // Poke the SW to boot Helios (by sending any message that triggers ensureHeliosBooted).
  // We just poll status; the SW already listens on runtime.onStartup / onInstalled.
  await chrome.runtime.sendMessage({ type: "get-helios-status" });
  while (currentStep === 4) {
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

finishBtn.addEventListener("click", async () => {
  await setSettings({ onboardingComplete: true });
  const url = chrome.runtime.getURL("src/options/options.html");
  location.replace(url);
});

const syncBack = document.getElementById("sync-back") as HTMLButtonElement;
syncBack.addEventListener("click", async () => {
  // Tear down any in-flight Helios boot so the next attempt picks up the new
  // advanced settings cleanly.
  try {
    await chrome.runtime.sendMessage({ type: "shutdown-helios" });
  } catch {
    /* best-effort */
  }
  showStep(3);
});

// --- Init ---
(async () => {
  await probeIpfs();
  const s = await getSettings();
  if (s.rpcUrls.length > 0) {
    // Already has some RPC — let user skip ahead once IPFS passes.
  }
})();

showStep(1);
