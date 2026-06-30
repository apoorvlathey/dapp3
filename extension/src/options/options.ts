import { getSettings, setSettings, onSettingsChanged } from "@/lib/settings";
import {
  invalidateKuboGatewayProbe,
  probeKuboApi,
  probeKuboGateway,
} from "@/lib/kubo";
import {
  DEFAULT_IPFS_GATEWAY_HOST,
  DEFAULT_IPFS_GATEWAY_PORT,
  getIpfsGatewayConfig,
  ipfsGatewayOriginPatterns,
  normalizeIpfsGatewayPort,
  parseIpfsGatewayHostInput,
  type IpfsGatewayConfig,
} from "@/lib/gateway";
import type { HeliosStatus } from "@/lib/helios-bridge";
import {
  DEFAULT_WEB3_ENTRY_BUDGET,
  DEFAULT_WEB3_SIZE_CAP_BYTES,
  type Web3CacheEntry,
} from "@/lib/web3url-cache";

const DEFAULT_CONSENSUS_RPC = "https://eth-beacon-chain.drpc.org";
// Suggestions populated into the shared `<datalist id="beacon-endpoints">`.
// Both the primary consensus RPC input and the verifier-add input use this
// list so users can pick a known beacon or paste their own.
const BEACON_ENDPOINTS = [
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
const heliosRestartBtn = document.getElementById(
  "helios-restart",
) as HTMLButtonElement;
const consensusForm = document.getElementById(
  "consensus-form",
) as HTMLFormElement;
const consensusInput = document.getElementById(
  "consensus-input",
) as HTMLInputElement;
const beaconDatalist = document.getElementById(
  "beacon-endpoints",
) as HTMLDataListElement;
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
const interceptGweiDomainsToggle = document.getElementById(
  "intercept-gweidomains",
) as HTMLInputElement;
const autoPinIpfsToggle = document.getElementById(
  "auto-pin-ipfs",
) as HTMLInputElement;
const autoPinIpfsStatus = document.getElementById(
  "auto-pin-ipfs-status",
) as HTMLElement;
const ipfsGatewayForm = document.getElementById(
  "ipfs-gateway-form",
) as HTMLFormElement;
const ipfsGatewayHostInput = document.getElementById(
  "ipfs-gateway-host",
) as HTMLInputElement;
const ipfsGatewayPortInput = document.getElementById(
  "ipfs-gateway-port",
) as HTMLInputElement;
const ipfsGatewayApplyBtn = document.getElementById(
  "ipfs-gateway-apply",
) as HTMLButtonElement;
const ipfsGatewayResetBtn = document.getElementById(
  "ipfs-gateway-reset",
) as HTMLButtonElement;
const ipfsGatewayPreview = document.getElementById(
  "ipfs-gateway-preview",
) as HTMLElement;
const ipfsGatewayStatus = document.getElementById(
  "ipfs-gateway-status",
) as HTMLElement;
const DEFAULT_IPFS_GATEWAY = {
  host: DEFAULT_IPFS_GATEWAY_HOST,
  port: DEFAULT_IPFS_GATEWAY_PORT,
};
let savedIpfsGateway: IpfsGatewayConfig = DEFAULT_IPFS_GATEWAY;

const verifierForm = document.getElementById(
  "verifier-form",
) as HTMLFormElement;
const verifierInput = document.getElementById(
  "verifier-input",
) as HTMLInputElement;
const verifierAddBtn = document.getElementById(
  "verifier-add",
) as HTMLButtonElement;
const verifierStatus = document.getElementById(
  "verifier-status",
) as HTMLElement;
const verifierListEl = document.getElementById(
  "verifier-list",
) as HTMLUListElement;

const checkpointForm = document.getElementById(
  "checkpoint-form",
) as HTMLFormElement;
const checkpointInput = document.getElementById(
  "checkpoint-input",
) as HTMLInputElement;
const checkpointApplyBtn = document.getElementById(
  "checkpoint-apply",
) as HTMLButtonElement;
const checkpointStatus = document.getElementById(
  "checkpoint-status",
) as HTMLElement;

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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    rpcStatus.textContent = "Only http:// or https:// URLs are accepted.";
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

function populateBeaconDatalist() {
  beaconDatalist.innerHTML = "";
  for (const url of BEACON_ENDPOINTS) {
    const opt = document.createElement("option");
    opt.value = url;
    beaconDatalist.appendChild(opt);
  }
}

function syncConsensusUI(stored: string | undefined) {
  // Empty stored value means "use the default". Show the default URL in the
  // input so the user can see/edit what's actually in use without having to
  // guess, but don't persist it until they actually hit Apply.
  consensusInput.value = stored || DEFAULT_CONSENSUS_RPC;
  consensusStatus.textContent = "";
}

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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    consensusStatus.textContent = "Only http:// or https:// URLs are accepted.";
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

async function rebootHeliosForBootstrapChange() {
  // Both consensus-RPC and verifier-list edits require the same dance: tear
  // down the running provider and let the next boot pick up the new config.
  // The SW only auto-reboots on rpcUrl changes, so consensus-side edits need
  // explicit shutdown + boot round-trips to take effect.
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
}

const TRASH_SVG_VERIFIER = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2.5 4h11"/>
    <path d="M5.5 4V2.5h5V4"/>
    <path d="M4 4l1 9.5h6L12 4"/>
    <path d="M6.5 7v4"/>
    <path d="M9.5 7v4"/>
  </svg>`;

function renderVerifierList(verifiers: string[]) {
  verifierListEl.innerHTML = "";
  for (const url of verifiers) {
    const li = document.createElement("li");
    li.className = "verifier-row";

    const span = document.createElement("span");
    span.className = "verifier-url";
    span.textContent = url;
    span.title = url;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "icon danger";
    removeBtn.title = "Remove verifier";
    removeBtn.setAttribute("aria-label", "Remove verifier");
    removeBtn.innerHTML = TRASH_SVG_VERIFIER;
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      const cur = (await getSettings()).consensusVerifiers ?? [];
      const next = cur.filter((v) => v !== url);
      await setSettings({ consensusVerifiers: next });
      renderVerifierList(next);
      verifierStatus.className = "hint";
      verifierStatus.textContent = "Removed. Rebooting Helios…";
      await rebootHeliosForBootstrapChange();
      verifierStatus.textContent = "Removed. Watching sync status above.";
    });

    li.append(span, removeBtn);
    verifierListEl.append(li);
  }
}

verifierForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const next = verifierInput.value.trim();
  if (!next) return;

  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    verifierStatus.textContent = "That URL isn't valid.";
    verifierStatus.className = "hint bad";
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    verifierStatus.textContent = "Only http:// or https:// URLs are accepted.";
    verifierStatus.className = "hint bad";
    return;
  }

  const settings = await getSettings();
  const current = settings.consensusVerifiers ?? [];
  // Reject duplicates (against existing verifiers and against the primary —
  // a verifier that's the same URL as the primary is just self-agreement).
  const primaryNormalized = (settings.consensusRpc || DEFAULT_CONSENSUS_RPC)
    .replace(/\/$/, "")
    .toLowerCase();
  const candidate = next.replace(/\/$/, "").toLowerCase();
  if (candidate === primaryNormalized) {
    verifierStatus.textContent =
      "Verifier must differ from the primary consensus RPC.";
    verifierStatus.className = "hint bad";
    return;
  }
  if (current.some((v) => v.replace(/\/$/, "").toLowerCase() === candidate)) {
    verifierStatus.textContent = "That verifier is already in the list.";
    verifierStatus.className = "hint bad";
    return;
  }

  verifierAddBtn.disabled = true;
  verifierStatus.className = "hint";
  verifierStatus.textContent = "Requesting permission…";

  const origin = parsed.origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      verifierStatus.textContent =
        "Permission denied — Helios can't reach that host.";
      verifierStatus.className = "hint bad";
      verifierAddBtn.disabled = false;
      return;
    }
  }

  const updated = [...current, next];
  await setSettings({ consensusVerifiers: updated });
  renderVerifierList(updated);
  verifierInput.value = "";
  verifierStatus.textContent = "Added. Rebooting Helios with the new verifier…";
  await rebootHeliosForBootstrapChange();
  verifierStatus.textContent = "Added. Watching sync status above.";
  verifierAddBtn.disabled = false;
});

function syncCheckpointUI(stored: string | undefined) {
  checkpointInput.value = stored ?? "";
  checkpointStatus.textContent = "";
  checkpointStatus.className = "hint";
}

function kuboApiSetupCommand(): string {
  return `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["chrome-extension://${chrome.runtime.id}"]' && ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'`;
}

function renderIpfsGatewayPreview(gateway: IpfsGatewayConfig) {
  ipfsGatewayPreview.textContent = `http://<cid>.ipfs.${gateway.host}:${gateway.port}/`;
}

function gatewaysEqual(a: IpfsGatewayConfig, b: IpfsGatewayConfig): boolean {
  return a.host === b.host && a.port === b.port;
}

function syncIpfsGatewayActions(gateway: IpfsGatewayConfig | null) {
  ipfsGatewayApplyBtn.disabled =
    !gateway || gatewaysEqual(gateway, savedIpfsGateway);
  ipfsGatewayResetBtn.disabled =
    gatewaysEqual(savedIpfsGateway, DEFAULT_IPFS_GATEWAY) &&
    !!gateway &&
    gatewaysEqual(gateway, DEFAULT_IPFS_GATEWAY);
}

async function ensureIpfsGatewayPermission(
  gateway: IpfsGatewayConfig,
): Promise<boolean> {
  if (gateway.host === DEFAULT_IPFS_GATEWAY_HOST) return true;
  const origins = ipfsGatewayOriginPatterns(gateway);
  try {
    const has = await chrome.permissions.contains({ origins });
    if (has) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function syncIpfsGatewayUI(settings: {
  ipfsGatewayHost?: string;
  ipfsGatewayPort?: number;
}) {
  const gateway = getIpfsGatewayConfig(settings);
  savedIpfsGateway = gateway;
  ipfsGatewayHostInput.value = gateway.host;
  ipfsGatewayPortInput.value = String(gateway.port);
  renderIpfsGatewayPreview(gateway);
  syncIpfsGatewayActions(gateway);
}

function readIpfsGatewayForm(
  opts: { report?: boolean } = {},
): IpfsGatewayConfig | null {
  const report = opts.report !== false;
  const hostInput = parseIpfsGatewayHostInput(ipfsGatewayHostInput.value);
  const port =
    hostInput?.port ?? normalizeIpfsGatewayPort(ipfsGatewayPortInput.value);
  if (!hostInput) {
    if (report) {
      ipfsGatewayStatus.textContent =
        "Enter a gateway host, or an http:// gateway URL without a path.";
      ipfsGatewayStatus.className = "hint bad";
    }
    return null;
  }
  if (!port) {
    if (report) {
      ipfsGatewayStatus.textContent = "Enter a port from 1 to 65535.";
      ipfsGatewayStatus.className = "hint bad";
    }
    return null;
  }
  return { host: hostInput.host, port };
}

async function saveIpfsGateway(gateway: IpfsGatewayConfig) {
  ipfsGatewayApplyBtn.disabled = true;
  ipfsGatewayResetBtn.disabled = true;
  ipfsGatewayStatus.className = "hint";
  ipfsGatewayStatus.textContent = "Requesting gateway permission…";
  const permitted = await ensureIpfsGatewayPermission(gateway);
  if (!permitted) {
    ipfsGatewayStatus.className = "hint bad";
    ipfsGatewayStatus.textContent =
      "Permission denied — dapp3 can't reach that gateway host.";
    syncIpfsGatewayActions(gateway);
    return;
  }

  ipfsGatewayStatus.textContent = "Saving and checking gateway…";
  await setSettings({
    ipfsGatewayHost: gateway.host,
    ipfsGatewayPort: gateway.port,
  });
  ipfsGatewayHostInput.value = gateway.host;
  ipfsGatewayPortInput.value = String(gateway.port);
  savedIpfsGateway = gateway;
  invalidateKuboGatewayProbe();
  const ok = await probeKuboGateway(gateway, { force: true });
  ipfsGatewayStatus.className = ok ? "hint" : "hint bad";
  ipfsGatewayStatus.textContent = ok
    ? `Saved. Kubo gateway is reachable at ${gateway.host}:${gateway.port}.`
    : `Saved, but the gateway did not answer at ${gateway.host}:${gateway.port}.`;
  renderIpfsGatewayPreview(gateway);
  syncIpfsGatewayActions(gateway);
}

function updateIpfsGatewayPreviewFromInputs() {
  const gateway = readIpfsGatewayForm({ report: false });
  if (!gateway) {
    syncIpfsGatewayActions(null);
    return;
  }
  ipfsGatewayStatus.textContent = "";
  ipfsGatewayStatus.className = "hint";
  renderIpfsGatewayPreview(gateway);
  syncIpfsGatewayActions(gateway);
}

ipfsGatewayHostInput.addEventListener("input", updateIpfsGatewayPreviewFromInputs);
ipfsGatewayPortInput.addEventListener("input", updateIpfsGatewayPreviewFromInputs);

ipfsGatewayForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const gateway = readIpfsGatewayForm();
  if (!gateway) return;
  renderIpfsGatewayPreview(gateway);
  await saveIpfsGateway(gateway);
});

ipfsGatewayResetBtn.addEventListener("click", async () => {
  const gateway = {
    host: DEFAULT_IPFS_GATEWAY_HOST,
    port: DEFAULT_IPFS_GATEWAY_PORT,
  };
  ipfsGatewayHostInput.value = gateway.host;
  ipfsGatewayPortInput.value = String(gateway.port);
  renderIpfsGatewayPreview(gateway);
  await saveIpfsGateway(gateway);
});

function normalizeCheckpoint(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) return null;
  return withPrefix.toLowerCase();
}

checkpointForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const normalized = normalizeCheckpoint(checkpointInput.value);
  if (normalized === null) {
    checkpointStatus.textContent =
      "Expected a 32-byte hex root (0x followed by 64 hex chars).";
    checkpointStatus.className = "hint bad";
    return;
  }
  checkpointApplyBtn.disabled = true;
  checkpointStatus.className = "hint";
  checkpointStatus.textContent = normalized
    ? "Saving and rebooting Helios with the new checkpoint…"
    : "Clearing pin and rebooting Helios with a fresh checkpoint…";
  // Empty string means "no pin" — store undefined so getSettings() falls
  // back to the live-fetch path on next boot.
  await setSettings({ checkpoint: normalized || undefined });
  syncCheckpointUI(normalized || undefined);
  await rebootHeliosForBootstrapChange();
  checkpointStatus.textContent = normalized
    ? "Pinned. Watching sync status above."
    : "Cleared. Watching sync status above.";
  checkpointApplyBtn.disabled = false;
});

function setHeliosDot(kind: "ok" | "bad" | "syncing" | "idle") {
  heliosDotEl.classList.remove("ok", "bad", "syncing");
  if (kind !== "idle") heliosDotEl.classList.add(kind);
}

function renderHelios(status: HeliosStatus | null) {
  if (!status) {
    heliosLiveEl.textContent = "Unknown";
    setHeliosDot("idle");
    setHeliosRestartBtn("Start", false);
    return;
  }
  switch (status.state) {
    case "idle":
      heliosLiveEl.textContent = "Idle";
      setHeliosDot("idle");
      setHeliosRestartBtn("Restart", false);
      break;
    case "booting":
      heliosLiveEl.textContent = "Booting…";
      setHeliosDot("syncing");
      setHeliosRestartBtn("Booting…", true);
      break;
    case "syncing":
      heliosLiveEl.textContent = "Syncing with consensus…";
      setHeliosDot("syncing");
      setHeliosRestartBtn("Restart", false);
      break;
    case "synced":
      heliosLiveEl.textContent = "Synced · verifying onchain reads locally";
      setHeliosDot("ok");
      setHeliosRestartBtn("Restart", false);
      break;
    case "error":
      heliosLiveEl.textContent = `Error: ${status.error ?? "unknown"}`;
      setHeliosDot("bad");
      setHeliosRestartBtn("Restart", false);
      break;
  }
}

function setHeliosRestartBtn(label: string, disabled: boolean) {
  // Don't stomp on the user's in-flight click — preserve the "Restarting…"
  // label and disabled state until the next status tick after the round-trip.
  if (heliosRestartBtn.dataset.busy === "1") return;
  heliosRestartBtn.textContent = label;
  heliosRestartBtn.disabled = disabled;
}

heliosRestartBtn.addEventListener("click", async () => {
  heliosRestartBtn.dataset.busy = "1";
  heliosRestartBtn.disabled = true;
  heliosRestartBtn.textContent = "Restarting…";
  try {
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
  } finally {
    delete heliosRestartBtn.dataset.busy;
  }
});

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
  if (document.activeElement !== verifierInput) {
    renderVerifierList(s.consensusVerifiers ?? []);
  }
  if (document.activeElement !== checkpointInput) {
    syncCheckpointUI(s.checkpoint);
  }
  if (
    document.activeElement !== ipfsGatewayHostInput &&
    document.activeElement !== ipfsGatewayPortInput
  ) {
    syncIpfsGatewayUI(s);
  }
  interceptToggle.checked = s.interceptEthLimo;
  interceptW3EthToggle.checked = s.interceptW3Eth;
  interceptGweiDomainsToggle.checked = s.interceptGweiDomains;
  autoPinIpfsToggle.checked = s.autoPinIpfsContent;
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

interceptGweiDomainsToggle.addEventListener("change", async () => {
  await setSettings({ interceptGweiDomains: interceptGweiDomainsToggle.checked });
});

autoPinIpfsToggle.addEventListener("change", async () => {
  autoPinIpfsToggle.disabled = true;
  autoPinIpfsStatus.className = "hint";

  if (!autoPinIpfsToggle.checked) {
    await setSettings({ autoPinIpfsContent: false });
    autoPinIpfsStatus.textContent = "Disabled. IPFS contenthashes will only be gateway-cached by Kubo.";
    autoPinIpfsToggle.disabled = false;
    return;
  }

  autoPinIpfsStatus.textContent = "Checking Kubo API access…";
  const probe = await probeKuboApi();
  if (!probe.ok) {
    autoPinIpfsToggle.checked = false;
    autoPinIpfsStatus.className = "hint bad";
    autoPinIpfsStatus.textContent =
      probe.kind.kind === "cors"
        ? `Kubo is rejecting this extension. Run once, restart Kubo, then enable again: ${kuboApiSetupCommand()}`
        : `Kubo API is not reachable at 127.0.0.1:5001: ${probe.kind.kind === "unreachable" ? probe.kind.cause : probe.kind.body}`;
    autoPinIpfsToggle.disabled = false;
    return;
  }

  await setSettings({ autoPinIpfsContent: true });
  autoPinIpfsStatus.textContent =
    "Enabled. New IPFS contenthash CIDs will be pinned in the background.";
  autoPinIpfsToggle.disabled = false;
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
  populateBeaconDatalist();
  syncRpcUI(s.rpcUrl);
  syncConsensusUI(s.consensusRpc);
  renderVerifierList(s.consensusVerifiers ?? []);
  syncCheckpointUI(s.checkpoint);
  syncIpfsGatewayUI(s);
  interceptToggle.checked = s.interceptEthLimo;
  interceptW3EthToggle.checked = s.interceptW3Eth;
  interceptGweiDomainsToggle.checked = s.interceptGweiDomains;
  autoPinIpfsToggle.checked = s.autoPinIpfsContent;
  syncWeb3Budgets(s);
  loadWeb3List();
  pollHelios();
})();
