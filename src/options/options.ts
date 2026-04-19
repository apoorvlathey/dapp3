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

const listEl = document.getElementById("rpc-list") as HTMLDivElement;
const addForm = document.getElementById("rpc-add") as HTMLFormElement;
const consensusEl = document.getElementById("consensus-rpc") as HTMLElement;
const heliosLiveEl = document.getElementById("helios-live") as HTMLElement;
const interceptToggle = document.getElementById(
  "intercept-ethlimo",
) as HTMLInputElement;

let cachedStats: Record<string, RpcStats> = {};
let cachedUrls: string[] = [];

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

    const urlSpan = document.createElement("span");
    urlSpan.className = "url";
    urlSpan.textContent = url;
    urlSpan.title = url;

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

function renderHelios(status: HeliosStatus | null) {
  if (!status) {
    heliosLiveEl.textContent = "unknown";
    return;
  }
  switch (status.state) {
    case "idle":
      heliosLiveEl.textContent = "idle";
      break;
    case "booting":
      heliosLiveEl.textContent = "booting…";
      break;
    case "syncing":
      heliosLiveEl.textContent = "syncing…";
      break;
    case "synced":
      heliosLiveEl.textContent = `synced (exec: ${status.executionRpc ?? "—"})`;
      break;
    case "error":
      heliosLiveEl.textContent = `error: ${status.error ?? "unknown"}`;
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
  consensusEl.textContent = s.consensusRpc || "(default) " + DEFAULT_CONSENSUS_RPC;
  interceptToggle.checked = s.interceptEthLimo;
  render();
});

interceptToggle.addEventListener("change", async () => {
  await setSettings({ interceptEthLimo: interceptToggle.checked });
});

(async () => {
  const s = await getSettings();
  if (!s.onboardingComplete && s.rpcUrls.length === 0) {
    location.replace(chrome.runtime.getURL("src/onboarding/onboarding.html"));
    return;
  }
  cachedUrls = s.rpcUrls;
  consensusEl.textContent = s.consensusRpc || "(default) " + DEFAULT_CONSENSUS_RPC;
  interceptToggle.checked = s.interceptEthLimo;
  await hydrateStats();
  pollHelios();
})();
