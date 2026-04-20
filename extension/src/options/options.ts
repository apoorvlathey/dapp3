import { getSettings, setSettings, onSettingsChanged } from "@/lib/settings";
import type { HeliosStatus } from "@/lib/helios-bridge";

const DEFAULT_CONSENSUS_RPC = "https://ethereum-beacon-api.publicnode.com";
const ALTERNATIVE_CONSENSUS_RPCS = [
  "https://ethereum-beacon-api.publicnode.com",
  "https://eth-beacon-chain.drpc.org",
  "https://lodestar-mainnet.chainsafe.io",
];

const rpcForm = document.getElementById("rpc-form") as HTMLFormElement;
const rpcInput = document.getElementById("rpc-input") as HTMLInputElement;
const rpcApplyBtn = document.getElementById("rpc-apply") as HTMLButtonElement;
const rpcStatus = document.getElementById("rpc-status") as HTMLElement;
const rpcRevealBtn = document.getElementById("rpc-reveal") as HTMLButtonElement;

const heliosLiveEl = document.getElementById("helios-live") as HTMLElement;
const heliosDotEl = document.getElementById("helios-dot") as HTMLElement;
const consensusForm = document.getElementById(
  "consensus-form",
) as HTMLFormElement;
const consensusInput = document.getElementById(
  "consensus-input",
) as HTMLInputElement;
const consensusChipsEl = document.getElementById(
  "consensus-chips",
) as HTMLElement;
const consensusStatus = document.getElementById(
  "consensus-status",
) as HTMLElement;
const consensusApplyBtn = document.getElementById(
  "consensus-apply",
) as HTMLButtonElement;
const interceptToggle = document.getElementById(
  "intercept-ethlimo",
) as HTMLInputElement;

const PENCIL_SVG = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11.5 2.5 13.5 4.5 5 13H3v-2z"/>
    <path d="M10 4l2 2"/>
  </svg>`;

const PENCIL_OFF_SVG = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11.5 2.5 13.5 4.5 5 13H3v-2z"/>
    <path d="M10 4l2 2"/>
    <path d="M2.5 2.5 13.5 13.5"/>
  </svg>`;

// RPC URLs often carry API keys. Keep the input masked until the user opts in.
let rpcRevealed = false;

function maskRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasSecretPath = u.pathname && u.pathname !== "/";
    return hasSecretPath ? `${u.origin}/•••` : u.origin;
  } catch {
    return url;
  }
}

function syncRpcUI(stored: string | undefined) {
  const value = stored ?? "";
  const editable = rpcRevealed || !value;
  rpcInput.dataset.real = value;
  rpcInput.value = editable ? value : maskRpcUrl(value);
  rpcInput.type = editable ? "url" : "text";
  rpcInput.readOnly = !editable;
  rpcApplyBtn.disabled = !editable;
  rpcRevealBtn.innerHTML = rpcRevealed ? PENCIL_OFF_SVG : PENCIL_SVG;
  rpcRevealBtn.title = rpcRevealed ? "Cancel edit" : "Edit URL";
  rpcRevealBtn.setAttribute("aria-label", rpcRevealBtn.title);
  rpcStatus.textContent = "";
  rpcStatus.className = "hint";
}

rpcRevealBtn.addEventListener("click", () => {
  rpcRevealed = !rpcRevealed;
  const real = rpcInput.dataset.real ?? "";
  syncRpcUI(real);
  if (rpcRevealed) rpcInput.focus();
});

rpcForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const next = rpcInput.value.trim();
  if (!next) return;

  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    rpcStatus.textContent = "That URL isn't valid.";
    rpcStatus.className = "hint bad";
    return;
  }

  rpcApplyBtn.disabled = true;
  rpcStatus.className = "hint";
  rpcStatus.textContent = "Requesting permission…";

  const origin = parsed.origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      rpcStatus.textContent =
        "Permission denied — Helios can't reach that host.";
      rpcStatus.className = "hint bad";
      rpcApplyBtn.disabled = false;
      return;
    }
  }

  const prev = (await getSettings()).rpcUrl;
  await setSettings({ rpcUrl: next });

  // The SW auto-reboots Helios when the rpcUrl changes; if the user saved the
  // same URL they already had, nudge the offscreen doc explicitly so the
  // "Save" click still feels like it did something.
  if (prev === next) {
    try {
      await chrome.runtime.sendMessage({ type: "shutdown-helios" });
    } catch {
      /* best-effort */
    }
    try {
      await chrome.runtime.sendMessage({ type: "boot-helios" });
    } catch {
      /* status poll will surface any error */
    }
  }

  // Optimistically flip the Helios status card to "Booting" so the user sees
  // the reboot reflected there immediately instead of a stale "Synced" until
  // the next poll tick.
  renderHelios({ state: "booting" });

  rpcRevealed = false;
  syncRpcUI(next);
  rpcStatus.textContent = "Saved. Rebooting Helios…";
  rpcApplyBtn.disabled = false;
});

function currentConsensusUrl(): string {
  return consensusInput.value.trim() || DEFAULT_CONSENSUS_RPC;
}

function renderConsensusChips(active: string) {
  consensusChipsEl.innerHTML = "";
  for (const url of ALTERNATIVE_CONSENSUS_RPCS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (url === active ? " active" : "");
    chip.textContent = new URL(url).host;
    chip.title = url;
    chip.addEventListener("click", () => {
      consensusInput.value = url;
      renderConsensusChips(url);
      consensusInput.focus();
    });
    consensusChipsEl.appendChild(chip);
  }
}

function syncConsensusUI(stored: string | undefined) {
  // Empty stored value means "use the default". Show the default URL in the
  // input so the user can see/edit what's actually in use without having to
  // guess — but don't persist it until they actually hit Apply.
  const effective = stored || DEFAULT_CONSENSUS_RPC;
  consensusInput.value = effective;
  renderConsensusChips(effective);
  consensusStatus.textContent = "";
}

consensusInput.addEventListener("input", () => {
  renderConsensusChips(currentConsensusUrl());
});

consensusForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const next = currentConsensusUrl();

  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    consensusStatus.textContent = "That URL isn't valid.";
    consensusStatus.className = "hint bad";
    return;
  }

  consensusApplyBtn.disabled = true;
  consensusStatus.className = "hint";
  consensusStatus.textContent = "Requesting permission…";

  const origin = parsed.origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      consensusStatus.textContent =
        "Permission denied — Helios can't reach that host.";
      consensusStatus.className = "hint bad";
      consensusApplyBtn.disabled = false;
      return;
    }
  }

  // Empty string in storage means "use default" — if the user typed the
  // default URL back, normalize to empty to keep settings clean.
  const toStore = next === DEFAULT_CONSENSUS_RPC ? undefined : next;
  await setSettings({ consensusRpc: toStore });

  // The SW only reboots Helios automatically when rpcUrl changes, so a
  // consensus-only edit needs an explicit shutdown + boot round-trip.
  consensusStatus.textContent = "Rebooting Helios with the new consensus RPC…";
  try {
    await chrome.runtime.sendMessage({ type: "shutdown-helios" });
  } catch {
    /* best-effort */
  }
  renderHelios({ state: "booting" });
  try {
    await chrome.runtime.sendMessage({ type: "boot-helios" });
  } catch {
    /* status poll will surface any error */
  }
  consensusStatus.textContent = "Applied. Watching sync status above.";
  consensusApplyBtn.disabled = false;
});

function setHeliosDot(kind: "ok" | "bad" | "syncing" | "idle") {
  heliosDotEl.classList.remove("ok", "bad", "syncing");
  if (kind !== "idle") heliosDotEl.classList.add(kind);
}

function renderHelios(status: HeliosStatus | null) {
  if (!status) {
    heliosLiveEl.textContent = "Unknown";
    setHeliosDot("idle");
    return;
  }
  switch (status.state) {
    case "idle":
      heliosLiveEl.textContent = "Idle";
      setHeliosDot("idle");
      break;
    case "booting":
      heliosLiveEl.textContent = "Booting…";
      setHeliosDot("syncing");
      break;
    case "syncing":
      heliosLiveEl.textContent = "Syncing with consensus…";
      setHeliosDot("syncing");
      break;
    case "synced":
      heliosLiveEl.textContent = "Synced · verifying on-chain reads locally";
      setHeliosDot("ok");
      break;
    case "error":
      heliosLiveEl.textContent = `Error: ${status.error ?? "unknown"}`;
      setHeliosDot("bad");
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
    await new Promise((r) => setTimeout(r, 1500));
  }
}

onSettingsChanged((s) => {
  // Only resync inputs if the user isn't mid-edit (focused). Otherwise a
  // storage-change event from this same page's own write would stomp on
  // whatever they were typing.
  if (document.activeElement !== rpcInput) {
    syncRpcUI(s.rpcUrl);
  }
  if (document.activeElement !== consensusInput) {
    syncConsensusUI(s.consensusRpc);
  }
  interceptToggle.checked = s.interceptEthLimo;
});

interceptToggle.addEventListener("change", async () => {
  await setSettings({ interceptEthLimo: interceptToggle.checked });
});

(async () => {
  const s = await getSettings();
  if (!s.onboardingComplete && !s.rpcUrl) {
    location.replace(chrome.runtime.getURL("onboarding.html"));
    return;
  }
  syncRpcUI(s.rpcUrl);
  syncConsensusUI(s.consensusRpc);
  interceptToggle.checked = s.interceptEthLimo;
  pollHelios();
})();
