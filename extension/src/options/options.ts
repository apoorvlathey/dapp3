import { getSettings, setSettings, onSettingsChanged } from "@/lib/settings";
import type { HeliosStatus } from "@/lib/helios-bridge";
import {
  DEFAULT_WEB3_ENTRY_BUDGET,
  DEFAULT_WEB3_SIZE_CAP_BYTES,
  type Web3CacheEntry,
} from "@/lib/web3url-cache";

const DEFAULT_CONSENSUS_RPC = "https://eth-beacon-chain.drpc.org";
const ALTERNATIVE_CONSENSUS_RPCS = [
  "https://eth-beacon-chain.drpc.org",
  "https://ethereum-beacon-api.publicnode.com",
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
const interceptW3EthToggle = document.getElementById(
  "intercept-w3eth",
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
      heliosLiveEl.textContent = "Synced · verifying onchain reads locally";
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
  interceptW3EthToggle.checked = s.interceptW3Eth;
  if (
    document.activeElement !== web3SizeCapInput &&
    document.activeElement !== web3EntryBudgetInput
  ) {
    syncWeb3Budgets(s);
  }
});

interceptToggle.addEventListener("change", async () => {
  await setSettings({ interceptEthLimo: interceptToggle.checked });
});

interceptW3EthToggle.addEventListener("change", async () => {
  await setSettings({ interceptW3Eth: interceptW3EthToggle.checked });
});

// ---------- Web3:// dapps section ----------

const web3SizeCapInput = document.getElementById(
  "web3-size-cap",
) as HTMLInputElement;
const web3EntryBudgetInput = document.getElementById(
  "web3-entry-budget",
) as HTMLInputElement;
const web3BudgetsForm = document.getElementById(
  "web3-budgets",
) as HTMLFormElement;
const web3BudgetsApplyBtn = document.getElementById(
  "web3-budgets-apply",
) as HTMLButtonElement;
const web3BudgetsStatus = document.getElementById(
  "web3-budgets-status",
) as HTMLElement;
const web3TotalsEl = document.getElementById("web3-totals") as HTMLElement;
const web3ListEl = document.getElementById("web3-list") as HTMLElement;

const TRASH_SVG = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2.5 4h11"/>
    <path d="M5.5 4V2.5h5V4"/>
    <path d="M4 4l1 9.5h6L12 4"/>
    <path d="M6.5 7v4"/>
    <path d="M9.5 7v4"/>
  </svg>`;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatRelative(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function syncWeb3Budgets(s: {
  web3SizeCapBytes?: number;
  web3EntryBudget?: number;
}) {
  const cap = s.web3SizeCapBytes ?? DEFAULT_WEB3_SIZE_CAP_BYTES;
  const budget = s.web3EntryBudget ?? DEFAULT_WEB3_ENTRY_BUDGET;
  web3SizeCapInput.value = String(Math.round(cap / (1024 * 1024)));
  web3EntryBudgetInput.value = String(budget);
}

web3BudgetsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const capMb = Number(web3SizeCapInput.value);
  const budget = Number(web3EntryBudgetInput.value);
  if (!Number.isFinite(capMb) || capMb < 1 || !Number.isFinite(budget) || budget < 1) {
    web3BudgetsStatus.textContent = "Pick numbers >= 1.";
    web3BudgetsStatus.className = "hint bad";
    return;
  }
  web3BudgetsApplyBtn.disabled = true;
  await setSettings({
    web3SizeCapBytes: Math.round(capMb * 1024 * 1024),
    web3EntryBudget: Math.round(budget),
  });
  web3BudgetsStatus.className = "hint";
  web3BudgetsStatus.textContent = "Saved. Eviction uses the new budget on next pin.";
  web3BudgetsApplyBtn.disabled = false;
});

async function loadWeb3List() {
  let entries: Web3CacheEntry[] = [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: "web3-list" });
    if (resp?.ok) entries = resp.entries as Web3CacheEntry[];
  } catch {
    /* SW may be asleep — render empty */
  }
  renderWeb3List(entries);
}

function renderWeb3List(entries: Web3CacheEntry[]) {
  web3ListEl.innerHTML = "";
  if (entries.length === 0) {
    web3TotalsEl.textContent = "No web3 dapps cached.";
    return;
  }
  const totalBytes = entries.reduce((acc, e) => acc + e.bodyLen, 0);
  web3TotalsEl.textContent = `${entries.length} dapp${entries.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)} pinned`;

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "web3-item";

    const main = document.createElement("div");
    main.className = "web3-item-main";
    const name = document.createElement("div");
    name.className = "web3-name";
    name.textContent = entry.ensName ?? entry.contractAddress;
    const meta = document.createElement("div");
    meta.className = "web3-meta";
    meta.textContent = `${entry.contractAddress.slice(0, 10)}… · ${formatBytes(entry.bodyLen)} · ${formatRelative(entry.lastAccess)}`;
    const cidLine = document.createElement("div");
    cidLine.className = "web3-cid";
    cidLine.textContent = entry.cid;
    main.append(name, meta, cidLine);

    const actions = document.createElement("div");
    actions.className = "web3-actions";
    const evictBtn = document.createElement("button");
    evictBtn.type = "button";
    evictBtn.className = "icon danger";
    evictBtn.title = "Evict from cache and unpin";
    evictBtn.setAttribute("aria-label", "Evict");
    evictBtn.innerHTML = TRASH_SVG;
    evictBtn.addEventListener("click", async () => {
      evictBtn.disabled = true;
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "web3-evict",
          contractAddress: entry.contractAddress,
        });
        if (!resp?.ok) {
          console.warn("[dapp3] evict failed", resp?.error);
          evictBtn.disabled = false;
          return;
        }
        await loadWeb3List();
      } catch (e) {
        console.warn("[dapp3] evict threw", e);
        evictBtn.disabled = false;
      }
    });
    actions.append(evictBtn);

    li.append(main, actions);
    web3ListEl.append(li);
  }
}

(async () => {
  const s = await getSettings();
  if (!s.onboardingComplete && !s.rpcUrl) {
    location.replace(chrome.runtime.getURL("onboarding.html"));
    return;
  }
  syncRpcUI(s.rpcUrl);
  syncConsensusUI(s.consensusRpc);
  interceptToggle.checked = s.interceptEthLimo;
  interceptW3EthToggle.checked = s.interceptW3Eth;
  syncWeb3Budgets(s);
  loadWeb3List();
  pollHelios();
})();
