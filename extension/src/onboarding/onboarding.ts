import { getSettings, setSettings } from "@/lib/settings";
import type { HeliosStatus } from "@/lib/helios-bridge";
import { requestHostPermission } from "@/lib/helios-client";
import {
  probeKuboApi,
  setKuboApiConfig,
  type KuboProbeResult,
} from "@/lib/kubo";
import { parseGatewayUrl, formatGatewayUrl } from "@/lib/gateway";
import { colorizeJson } from "@/lib/colorize-json";

const DEFAULT_CONSENSUS_RPC = "https://eth-beacon-chain.drpc.org";
const ALTERNATIVE_CONSENSUS_RPCS = [
  "https://eth-beacon-chain.drpc.org",
  "https://ethereum-beacon-api.publicnode.com",
  "https://lodestar-mainnet.chainsafe.io",
];

type StepId = 1 | 2 | 3;
let currentStep: StepId = 1;

const stepper = document.querySelector(".stepper") as HTMLElement;
const panels: Record<StepId, HTMLElement> = {
  1: document.querySelector<HTMLElement>('.step-panel[data-step="1"]')!,
  2: document.querySelector<HTMLElement>('.step-panel[data-step="2"]')!,
  3: document.querySelector<HTMLElement>('.step-panel[data-step="3"]')!,
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
const gatewayDot = document.getElementById("gateway-dot") as HTMLSpanElement;
const gatewayText = document.getElementById("gateway-status-text") as HTMLSpanElement;
const kuboApiDot = document.getElementById("kubo-api-dot") as HTMLSpanElement;
const kuboApiText = document.getElementById("kubo-api-status-text") as HTMLSpanElement;
const ipfsNext = document.getElementById("ipfs-next") as HTMLButtonElement;
const ipfsRecheck = document.getElementById("ipfs-recheck") as HTMLButtonElement;
const ipfsForm = document.getElementById("ipfs-form") as HTMLFormElement;
const ipfsGatewayInput = document.getElementById(
  "ipfs-gateway-input",
) as HTMLInputElement;
const kuboApiInput = document.getElementById(
  "kubo-api-input",
) as HTMLInputElement;
const ipfsPermPreview = document.getElementById(
  "ipfs-perm-preview",
) as HTMLUListElement;

// Tracks the most recent IPFS probe result so the finish handler can persist
// `interceptEthLimo` accurately. Defaults to false so a user who never makes
// it through step 1 never has eth.limo / eth.link interception silently enabled.
let lastIpfsOk = false;

async function probeIpfsSetup(): Promise<boolean> {
  const panel = panels[1];
  // Don't strip state-ok/state-bad here — doing so reveals the "No node yet?"
  // hint for the duration of the probe even when the last result was green,
  // which flashes as a brief flicker on Re-check. Only commit the new state
  // once the probe resolves.
  gatewayDot.classList.remove("ok", "bad");
  kuboApiDot.classList.remove("ok", "bad");
  ipfsRecheck.classList.add("spinning");
  gatewayText.textContent = "Checking IPFS gateway…";
  kuboApiText.textContent = "Checking Kubo API…";

  // Parse both URLs from the inputs
  const gatewayUrl = ipfsGatewayInput.value.trim() || "http://localhost:8080";
  const parsedGateway = parseGatewayUrl(gatewayUrl);
  const apiUrl = kuboApiInput.value.trim() || "http://127.0.0.1:5001";
  const parsedApi = parseGatewayUrl(apiUrl);

  if (!parsedGateway) {
    gatewayDot.classList.add("bad");
    gatewayText.textContent = "Invalid gateway URL format";
    kuboApiDot.classList.add("bad");
    kuboApiText.textContent = "Waiting for valid gateway URL…";
    ipfsNext.disabled = true;
    panel.classList.remove("state-ok");
    panel.classList.add("state-bad");
    lastIpfsOk = false;
    setTimeout(() => ipfsRecheck.classList.remove("spinning"), 400);
    return false;
  }

  if (!parsedApi) {
    kuboApiDot.classList.add("bad");
    kuboApiText.textContent = "Invalid Kubo API URL format";
    ipfsNext.disabled = true;
    panel.classList.remove("state-ok");
    panel.classList.add("state-bad");
    lastIpfsOk = false;
    setTimeout(() => ipfsRecheck.classList.remove("spinning"), 400);
    return false;
  }

  // Request permissions for both origins at once
  const origins = [
    `${parsedGateway.protocol}//${parsedGateway.host}:${parsedGateway.port}/*`,
    `${parsedApi.protocol}//${parsedApi.host}:${parsedApi.port}/*`,
  ];
  const hasAll = await chrome.permissions.contains({ origins });
  if (!hasAll) {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      gatewayDot.classList.add("bad");
      gatewayText.textContent = "Permission denied — can't reach configured hosts.";
      kuboApiDot.classList.add("bad");
      kuboApiText.textContent = "Permission denied — can't reach configured hosts.";
      ipfsNext.disabled = true;
      panel.classList.remove("state-ok");
      panel.classList.add("state-bad");
      lastIpfsOk = false;
      setTimeout(() => ipfsRecheck.classList.remove("spinning"), 400);
      return false;
    }
  }

  // Save both configs to settings
  await setSettings({
    ipfsGateway: {
      protocol: parsedGateway.protocol,
      host: parsedGateway.host,
      port: parsedGateway.port,
    },
  });
  setKuboApiConfig(parsedApi);

  // Probe the subdomain gateway with the empty-UnixFS CID. `no-cors` means we
  // cannot read the response, but a resolved promise proves the port answered
  // — i.e. Kubo is up and serving subdomains on the configured gateway.
  let gatewayOk = false;
  try {
    await fetch(`${parsedGateway.protocol}//bafkqaaa.ipfs.${parsedGateway.host}:${parsedGateway.port}/`, {
      mode: "no-cors",
      // The gateway serves this empty-UnixFS CID with
      // `Cache-Control: public, max-age=31536000, immutable`, so once the user
      // has hit it successfully Chrome will happily serve the cached response
      // long after Kubo has stopped — making the probe look green while the
      // port is actually dead. `no-store` forces a real network round-trip.
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    gatewayDot.classList.add("ok");
    gatewayText.textContent = `Connected at ${parsedGateway.host}:${parsedGateway.port}`;
    gatewayOk = true;
  } catch (e) {
    gatewayDot.classList.add("bad");
    gatewayText.textContent = `Not reachable: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Probe Kubo RPC API
  let apiOk = false;
  const apiResult = await probeKuboApi();
  if (apiResult.ok) {
    kuboApiDot.classList.add("ok");
    kuboApiText.textContent = "Kubo API connected";
    apiOk = true;
  } else {
    kuboApiDot.classList.add("bad");
    switch (apiResult.kind.kind) {
      case "cors":
        kuboApiText.textContent = "Kubo API CORS issue — see instructions below";
        break;
      case "unreachable":
        kuboApiText.textContent = `API not reachable: ${apiResult.kind.cause}`;
        break;
      case "http":
        kuboApiText.textContent = `API error: HTTP ${apiResult.kind.status} — ${apiResult.kind.body}`;
        break;
      case "parse":
        kuboApiText.textContent = `API error: unparseable response — ${apiResult.kind.body}`;
        break;
    }
  }

  // Surface the ERC-4804 CORS warning if needed
  await probeKuboApiAndRender(apiResult);

  // Gate Continue on both connections being healthy
  ipfsNext.disabled = !(gatewayOk && apiOk);
  if (gatewayOk && apiOk) {
    panel.classList.remove("state-bad");
    panel.classList.add("state-ok");
    lastIpfsOk = true;
  } else {
    panel.classList.remove("state-ok");
    panel.classList.add("state-bad");
    lastIpfsOk = false;
  }

  // Kill the spin a tick after the probe settles so the animation completes
  // even for near-instant responses (cached failures resolve in <10ms).
  setTimeout(() => ipfsRecheck.classList.remove("spinning"), 400);
  return gatewayOk && apiOk;
}

// Probe Kubo's RPC API and surface a warning if the extension origin is not
// allowlisted. Accepts an optional pre-fetched result so the caller can probe
// once and render both the status indicator and the warning from the same data.
async function probeKuboApiAndRender(providedResult?: KuboProbeResult) {
  const panel = panels[1];
  panel.querySelector("#api-warning")?.remove();

  // Apply the Kubo API URL from the input before probing
  const apiUrl = kuboApiInput.value.trim() || "http://127.0.0.1:5001";
  const parsedApi = parseGatewayUrl(apiUrl);
  if (parsedApi) {
    setKuboApiConfig(parsedApi);
  }

  const result = providedResult ?? await probeKuboApi();
  if (result.ok) return;
  if (result.kind.kind !== "cors") return; // unreachable already covered by gateway probe

  const extId = chrome.runtime.id;
  const cmd = `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["chrome-extension://${extId}"]' && ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'`;
  const jsonSnippet = [
    `{`,
    `  ...`,
    `  "API": {`,
    `    "HTTPHeaders": {`,
    `      ...`,
    `      "Access-Control-Allow-Methods": ["POST"],`,
    `      "Access-Control-Allow-Origin": [`,
    `        ...,`,
    `        "chrome-extension://${extId}"`,
    `      ]`,
    `    }`,
    `  },`,
    `  ...`,
    `}`,
  ].join("\n");

  const wrap = document.createElement("details");
  wrap.id = "api-warning";
  wrap.className = "api-warning";
  wrap.innerHTML = `
    <summary class="api-warning-title">Optional: enable <a href="https://eip.tools/eip/4804" target="_blank" rel="noopener">ERC-4804</a> dapps</summary>
    <div class="api-warning-content">
      <p class="api-warning-body">
        Run once, restart Kubo. Standard <code>.eth</code>/IPFS sites already work without this.
      </p>
      <div class="cmd-block">
        <pre data-cmd="cmd"></pre>
        <button class="copy-btn" type="button" data-target="cmd">Copy</button>
      </div>
      <div class="api-walkthrough">
        <p class="api-walkthrough-label">No CLI? Use IPFS Desktop's UI</p>
        <ol>
          <li>Open IPFS Desktop → Settings → Kubo Config.</li>
          <li>
            Merge these two keys into <code>API.HTTPHeaders</code> (keep any
            entries already there):
            <div class="cmd-block json-block">
              <pre data-cmd="json"></pre>
              <button class="copy-btn" type="button" data-target="json">Copy</button>
            </div>
          </li>
          <li>Save and restart Kubo.</li>
        </ol>
      </div>
      <div class="api-warning-footer">
        <button class="recheck-btn" type="button" data-action="recheck-api">
          <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13.5 3.5v3h-3" />
            <path d="M2.5 12.5v-3h3" />
            <path d="M3.5 6.5a5 5 0 0 1 9 -1.5l1 1.5M12.5 9.5a5 5 0 0 1 -9 1.5l-1 -1.5" />
          </svg>
          <span>Recheck</span>
        </button>
      </div>
    </div>
  `;
  wrap.querySelector('[data-cmd="cmd"]')!.textContent = cmd;
  wrap.querySelector('[data-cmd="json"]')!.innerHTML = colorizeJson(jsonSnippet);

  wrap.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.target;
      if (!target) return;
      const text =
        wrap.querySelector(`[data-cmd="${target}"]`)?.textContent ?? "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      const original = btn.textContent ?? "Copy";
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    });
  });

  wrap
    .querySelector<HTMLButtonElement>('[data-action="recheck-api"]')
    ?.addEventListener("click", async () => {
      const recheck = wrap.querySelector<HTMLButtonElement>(
        '[data-action="recheck-api"]',
      );
      if (recheck) recheck.disabled = true;
      const r = await probeKuboApi();
      if (r.ok) {
        wrap.classList.add("ok");
        wrap.open = true;
        const title = wrap.querySelector(".api-warning-title");
        if (title) title.textContent = "Kubo API is now allowing this extension";
        const body = wrap.querySelector(".api-warning-body");
        if (body)
          body.innerHTML =
            'Setup complete. <a href="https://eip.tools/eip/4804" target="_blank" rel="noopener">ERC-4804</a> dapps will work after this onboarding finishes.';
        wrap
          .querySelectorAll(
            ".cmd-block, .recheck-btn, .api-walkthrough, .api-warning-footer",
          )
          .forEach((el) => el.remove());
        return;
      }
      if (recheck) recheck.disabled = false;
    });

  const footer = panel.querySelector(".panel-footer");
  if (footer) panel.insertBefore(wrap, footer);
  else panel.appendChild(wrap);
}

function renderIpfsPermPreview() {
  ipfsPermPreview.innerHTML = "";
  const items: string[] = [];
  try {
    const u = new URL(ipfsGatewayInput.value);
    items.push(`${u.origin}  (your IPFS gateway — reads IPFS content)`);
  } catch {
    items.push("<your IPFS gateway, once entered above>");
  }
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    ipfsPermPreview.appendChild(li);
  }
}

ipfsGatewayInput.addEventListener("input", renderIpfsPermPreview);
renderIpfsPermPreview();

ipfsRecheck.addEventListener("click", async () => {
  await probeIpfsSetup();
});

ipfsNext.addEventListener("click", async () => {
  // Ensure the gateway URL is saved before proceeding
  const gatewayUrl = ipfsGatewayInput.value.trim() || "http://localhost:8080";
  const parsed = parseGatewayUrl(gatewayUrl);
  if (parsed) {
    const origin = `${parsed.protocol}//${parsed.host}:${parsed.port}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return;
    }
    await setSettings({
      ipfsGateway: {
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
      },
    });
  }
  // Also save the Kubo API URL
  const apiUrl = kuboApiInput.value.trim() || "http://127.0.0.1:5001";
  const parsedApi = parseGatewayUrl(apiUrl);
  if (parsedApi) {
    const origin = `${parsedApi.protocol}//${parsedApi.host}:${parsedApi.port}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return;
    }
    await setSettings({
      kuboApi: {
        protocol: parsedApi.protocol,
        host: parsedApi.host,
        port: parsedApi.port,
      },
    });
  }
  showStep(2);
});

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
    rpcInput.classList.add("invalid");
    rpcInput.focus();
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    rpcInput.classList.add("invalid");
    rpcInput.focus();
    alert("Only http:// or https:// URLs are accepted.");
    return;
  }
  rpcInput.classList.remove("invalid");
  const { consensusRpc } = await getSettings();
  const consensus = consensusRpc || DEFAULT_CONSENSUS_RPC;
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
  await setSettings({ rpcUrl: url, consensusRpc: consensus });
  showStep(3);
  void startHelios();
});

// --- Step 3: Sync ---
const heliosDot = document.getElementById("helios-dot") as HTMLSpanElement;
const heliosText = document.getElementById("helios-status-text") as HTMLSpanElement;
const syncTitle = document.getElementById("sync-title") as HTMLElement;
const syncLede = document.getElementById("sync-lede") as HTMLElement;
const syncRecovery = document.getElementById("sync-recovery") as HTMLElement;
const consensusChipsEl = document.getElementById("consensus-chips") as HTMLElement;
const advConsensusInput = document.getElementById("adv-consensus-input") as HTMLInputElement;
const advCheckpointInput = document.getElementById("adv-checkpoint-input") as HTMLInputElement;
const advApplyBtn = document.getElementById("adv-apply") as HTMLButtonElement;
const finishBtn = document.getElementById("finish") as HTMLButtonElement;
const syncBack = document.getElementById("sync-back") as HTMLButtonElement;

// Once Helios synces we persist `onboardingComplete: true` immediately — even
// if the user never clicks Finish — so closing the tab mid-setup doesn't trap
// them back on the onboarding page the next time they open the popup. The
// Finish button becomes a convenience redirect to the options dashboard.
let persistedComplete = false;

function renderConsensusChips() {
  consensusChipsEl.innerHTML = "";
  for (const url of ALTERNATIVE_CONSENSUS_RPCS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = new URL(url).host;
    chip.title = url;
    chip.addEventListener("click", () => {
      void applyConsensus(url, undefined);
    });
    consensusChipsEl.appendChild(chip);
  }
}
renderConsensusChips();

async function applyConsensus(consensusUrl: string, checkpoint: string | undefined) {
  // Ask for permission on the new host if we don't already have it.
  try {
    const parsed = new URL(consensusUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      alert("Only http:// or https:// URLs are accepted.");
      return;
    }
    const origin = parsed.origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        alert("Permission not granted — Helios can't reach that host.");
        return;
      }
    }
  } catch {
    alert("That URL isn't valid.");
    return;
  }

  await setSettings({ consensusRpc: consensusUrl, checkpoint });

  // Tear down any in-flight boot so the next one picks up the new config.
  try {
    await chrome.runtime.sendMessage({ type: "shutdown-helios" });
  } catch {
    /* best-effort */
  }

  // Reset UI back to "starting"
  syncTitle.textContent = "Starting Helios";
  syncLede.textContent = "Retrying with updated consensus RPC…";
  syncRecovery.hidden = true;
  finishBtn.disabled = true;
  void startHelios();
}

advApplyBtn.addEventListener("click", () => {
  const consensusUrl = advConsensusInput.value.trim() || DEFAULT_CONSENSUS_RPC;
  let checkpoint: string | undefined = advCheckpointInput.value.trim() || undefined;
  if (checkpoint && !checkpoint.startsWith("0x")) checkpoint = "0x" + checkpoint;
  void applyConsensus(consensusUrl, checkpoint);
});

function renderHelios(status: HeliosStatus | null) {
  heliosDot.classList.remove("ok", "bad");

  if (!status) {
    heliosText.textContent = "waiting…";
    return;
  }
  switch (status.state) {
    case "idle":
      heliosText.textContent = "not yet started";
      break;
    case "booting":
      heliosText.textContent = "Booting Helios WASM…";
      break;
    case "syncing":
      heliosText.textContent = "Syncing with Ethereum consensus…";
      break;
    case "synced":
      heliosText.textContent = "Synced · verifying onchain reads locally";
      heliosDot.classList.add("ok");
      syncTitle.textContent = "You're all set";
      syncLede.textContent =
        "Helios is synced. Finish to open the dapp3 home page.";
      syncRecovery.hidden = true;
      finishBtn.disabled = false;
      if (!persistedComplete) {
        persistedComplete = true;
        void setSettings({
          onboardingComplete: true,
          interceptEthLimo: lastIpfsOk,
          interceptW3Eth: lastIpfsOk,
        });
      }
      break;
    case "error":
      heliosText.textContent = `Sync failed: ${status.error ?? "unknown error"}`;
      heliosDot.classList.add("bad");
      syncTitle.textContent = "Couldn't reach consensus";
      syncLede.textContent =
        "Helios couldn't start with the current beacon-chain RPC. Try another one below.";
      syncRecovery.hidden = false;
      finishBtn.disabled = true;
      break;
  }
}

async function startHelios() {
  const { rpcUrl, consensusRpc } = await getSettings();
  const consensus = consensusRpc || DEFAULT_CONSENSUS_RPC;
  try {
    if (rpcUrl) await requestHostPermission(rpcUrl);
    await requestHostPermission(consensus);
  } catch (e) {
    console.error("[dapp3] onboarding: host permission request failed", e);
  }
  console.log("[dapp3] onboarding: sending boot-helios");
  chrome.runtime.sendMessage({ type: "boot-helios" }).then(
    (resp) => console.log("[dapp3] onboarding: boot-helios response", resp),
    (e) => console.error("[dapp3] onboarding: boot-helios failed", e),
  );
  while (currentStep === 3) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "get-helios-status",
      });
      console.log("[dapp3] onboarding: get-helios-status poll", resp?.status);
      renderHelios(resp?.status ?? null);
    } catch (e) {
      console.error("[dapp3] onboarding: get-helios-status poll error", e);
      renderHelios(null);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

finishBtn.addEventListener("click", async () => {
  // State was already persisted the moment Helios reached "synced" (see
  // renderHelios). Belt-and-suspenders: re-save in case the user somehow
  // clicked Finish before the sync branch ran, then redirect to the home
  // launcher so the user lands somewhere they can immediately type a name.
  if (!persistedComplete) {
    persistedComplete = true;
    await setSettings({
      onboardingComplete: true,
      interceptEthLimo: lastIpfsOk,
      interceptW3Eth: lastIpfsOk,
    });
  }
  const url = chrome.runtime.getURL("home.html");
  location.replace(url);
});

syncBack.addEventListener("click", async () => {
  // Tear down any in-flight Helios boot so returning to step 2 doesn't leave
  // a zombie sync running against a stale URL.
  try {
    await chrome.runtime.sendMessage({ type: "shutdown-helios" });
  } catch {
    /* best-effort */
  }
  showStep(2);
});

// --- Init ---
(async () => {
  const s = await getSettings();
  // Prefill the IPFS gateway URL if we have one saved
  if (s.ipfsGateway) {
    ipfsGatewayInput.value = formatGatewayUrl(s.ipfsGateway);
  }
  // Prefill the Kubo API URL if we have one saved
  if (s.kuboApi) {
    kuboApiInput.value = formatGatewayUrl(s.kuboApi);
    setKuboApiConfig(s.kuboApi);
  }
  await probeIpfsSetup();
  // Prefill the execution RPC. Default to eth.drpc.org for new users; if the
  // user already has a saved RPC (e.g. revisiting onboarding), keep it.
  rpcInput.value = s.rpcUrl ?? "https://eth.drpc.org";
  renderPermPreview();
  // Prefill the advanced fields in case the user already has custom values.
  advConsensusInput.value = s.consensusRpc ?? "";
  advCheckpointInput.value = s.checkpoint ?? "";
})();

showStep(1);
