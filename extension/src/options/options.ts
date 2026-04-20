import { getSettings, setSettings, onSettingsChanged } from "@/lib/settings";
import {
  getAllStats,
  onStatsChanged,
  avgLatency,
  successRate,
  clearStats,
  type RpcStats,
} from "@/lib/rpc-stats";
import type { HeliosStatus } from "@/lib/helios-bridge";

const DEFAULT_CONSENSUS_RPC = "https://ethereum-beacon-api.publicnode.com";
const ALTERNATIVE_CONSENSUS_RPCS = [
  "https://ethereum-beacon-api.publicnode.com",
  "https://eth-beacon-chain.drpc.org",
  "https://lodestar-mainnet.chainsafe.io",
];

const listEl = document.getElementById("rpc-list") as HTMLDivElement;
const addForm = document.getElementById("rpc-add") as HTMLFormElement;
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

  // The SW only reboots Helios automatically when `rpcUrls[0]` changes, so a
  // consensus-only edit needs an explicit shutdown + boot round-trip.
  consensusStatus.textContent = "Rebooting Helios with the new consensus RPC…";
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
  consensusStatus.textContent = "Applied. Watching sync status above.";
  consensusApplyBtn.disabled = false;
});

let cachedStats: Record<string, RpcStats> = {};
let cachedUrls: string[] = [];
// RPC URLs often carry API keys in their path (Infura, Alchemy, QuickNode…).
// Rows stay masked by default and the user opts into revealing per-row — the
// set persists across re-renders for the lifetime of the page.
const revealedUrls = new Set<string>();

function maskRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasSecretPath = u.pathname && u.pathname !== "/";
    return hasSecretPath ? `${u.origin}/•••` : u.origin;
  } catch {
    return url;
  }
}

function fmtAge(ts?: number): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function render() {
  listEl.innerHTML = "";
  if (cachedUrls.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No RPCs added yet. Add one below to get started.";
    listEl.appendChild(empty);
    return;
  }

  cachedUrls.forEach((url, idx) => {
    const row = document.createElement("div");
    row.className = "rpc-row" + (idx === 0 ? " primary" : "");

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = idx === 0 ? "PRIMARY" : `#${idx + 1}`;

    const revealed = revealedUrls.has(url);
    const urlSpan = document.createElement("span");
    urlSpan.className = "url" + (revealed ? " revealed" : " masked");
    urlSpan.textContent = revealed ? url : maskRpcUrl(url);
    urlSpan.title = revealed ? url : "Hidden — click the eye to reveal";

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(iconBtn("↑", idx === 0, "Move up", () => move(idx, -1)));
    actions.appendChild(
      iconBtn(
        "↓",
        idx === cachedUrls.length - 1,
        "Move down",
        () => move(idx, 1),
      ),
    );
    actions.appendChild(
      eyeBtn(revealed, () => {
        if (revealedUrls.has(url)) revealedUrls.delete(url);
        else revealedUrls.add(url);
        render();
      }),
    );
    actions.appendChild(iconBtn("⟲", false, "Probe now", () => probe(url)));
    actions.appendChild(
      iconBtn("✕", false, "Remove", () => remove(url), "danger"),
    );

    row.append(rank, urlSpan, actions);

    const stats = cachedStats[url];
    const statsEl = document.createElement("div");
    statsEl.className = "stats";
    const rate = stats ? successRate(stats) : null;
    const avg = stats ? avgLatency(stats) : null;
    statsEl.append(
      stat("success", stats?.success ?? 0, stats?.success ? "ok" : undefined),
      stat("failure", stats?.failure ?? 0, stats?.failure ? "bad" : undefined),
      stat(
        "success rate",
        rate == null ? "—" : `${Math.round(rate * 100)}%`,
        rate == null ? undefined : rate > 0.95 ? "ok" : rate < 0.5 ? "bad" : undefined,
      ),
      stat("avg latency", avg == null ? "—" : `${avg}ms`),
    );
    row.append(statsEl);

    if (stats?.lastFailureReason) {
      const lf = document.createElement("div");
      lf.className = "last-failure";
      lf.textContent = `last failure ${fmtAge(stats.lastFailureAt)} (${stats.lastFailureKind}): ${stats.lastFailureReason}`;
      lf.title = stats.lastFailureReason;
      row.append(lf);
    }

    listEl.appendChild(row);
  });
}

function iconBtn(
  label: string,
  disabled: boolean,
  title: string,
  onClick: () => void,
  extraClass = "",
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon" + (extraClass ? ` ${extraClass}` : "");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  if (!disabled) b.addEventListener("click", onClick);
  return b;
}

const EYE_OPEN_SVG = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/>
    <circle cx="8" cy="8" r="2"/>
  </svg>`;

const EYE_OFF_SVG = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2.5 3.5 13.5 12.5"/>
    <path d="M6.2 4A8.4 8.4 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a13 13 0 0 1-2.2 2.7"/>
    <path d="M10.2 10.7A6.9 6.9 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a13 13 0 0 1 2.6-3"/>
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8"/>
  </svg>`;

function eyeBtn(revealed: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon";
  b.type = "button";
  b.innerHTML = revealed ? EYE_OFF_SVG : EYE_OPEN_SVG;
  b.title = revealed ? "Hide URL" : "Reveal full URL";
  b.setAttribute("aria-label", b.title);
  b.addEventListener("click", onClick);
  return b;
}

function stat(
  label: string,
  value: string | number,
  tone?: "ok" | "bad",
): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = `<div class="k">${label}</div><div class="v${tone ? ` ${tone}` : ""}">${value}</div>`;
  return el;
}

async function move(idx: number, delta: number) {
  const next = [...cachedUrls];
  const target = idx + delta;
  if (target < 0 || target >= next.length) return;
  const [a] = next.splice(idx, 1);
  if (!a) return;
  next.splice(target, 0, a);
  await setSettings({ rpcUrls: next });
}

async function remove(url: string) {
  await setSettings({ rpcUrls: cachedUrls.filter((u) => u !== url) });
  await clearStats(url);
}

async function probe(url: string) {
  heliosLiveEl.textContent = `probing ${new URL(url).host}…`;
  const res = await chrome.runtime.sendMessage({ type: "probe-rpc", url });
  if (res?.ok) {
    heliosLiveEl.textContent = `probed ${new URL(url).host} · block ${res.blockNumber ?? "?"} · ${Math.round(res.latencyMs ?? 0)}ms`;
  } else {
    heliosLiveEl.textContent = `probe failed: ${res?.error ?? "unknown"}`;
  }
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(addForm);
  const url = String(data.get("url") ?? "").trim();
  if (!url) return;
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
    const consensusOrigin = new URL(consensus).origin + "/*";
    if (!origins.includes(consensusOrigin)) origins.push(consensusOrigin);
  } catch {
    /* skip */
  }
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    alert(
      "Permission was not granted. The extension needs access to the execution RPC and the Helios consensus RPC.",
    );
    return;
  }
  if (cur.rpcUrls.includes(url)) return;
  await setSettings({ rpcUrls: [...cur.rpcUrls, url] });
  addForm.reset();
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

async function hydrateStats() {
  const all = await getAllStats();
  cachedStats = Object.fromEntries(all.map((s) => [s.url, s]));
  render();
}

onStatsChanged((all) => {
  cachedStats = Object.fromEntries(all.map((s) => [s.url, s]));
  render();
});

onSettingsChanged((s) => {
  cachedUrls = s.rpcUrls;
  // Only resync the consensus input if the user isn't mid-edit (focused).
  // Otherwise a storage-change event from this same page's own write would
  // stomp on whatever they were typing.
  if (document.activeElement !== consensusInput) {
    syncConsensusUI(s.consensusRpc);
  }
  interceptToggle.checked = s.interceptEthLimo;
  render();
});

interceptToggle.addEventListener("change", async () => {
  await setSettings({ interceptEthLimo: interceptToggle.checked });
});

(async () => {
  const s = await getSettings();
  if (!s.onboardingComplete && s.rpcUrls.length === 0) {
    location.replace(chrome.runtime.getURL("onboarding.html"));
    return;
  }
  cachedUrls = s.rpcUrls;
  syncConsensusUI(s.consensusRpc);
  interceptToggle.checked = s.interceptEthLimo;
  await hydrateStats();
  pollHelios();
})();
