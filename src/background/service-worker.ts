import "@/lib/sw-dom-shim";
import { resolveEns, getOrStartHelios, probeRpc } from "@/lib/resolver";
import { buildSubdomainUrl } from "@/lib/gateway";
import { getHeliosStatus, shutdownHelios } from "@/lib/helios-client";
import { getSettings, onSettingsChanged } from "@/lib/settings";
import type { TabContext } from "@/lib/messaging";

const ETH_HOST_RE = /^[a-z0-9-]+\.eth\.?$/i;

function errorPageUrl(name: string, error: string): string {
  const u = new URL(chrome.runtime.getURL("src/error/error.html"));
  u.searchParams.set("name", name);
  u.searchParams.set("error", error);
  return u.toString();
}

function interstitialUrl(name: string, path: string, search: string, hash: string): string {
  const u = new URL(chrome.runtime.getURL("src/interstitial/interstitial.html"));
  u.searchParams.set("name", name);
  u.searchParams.set("path", path);
  u.searchParams.set("search", search);
  u.searchParams.set("hash", hash);
  return u.toString();
}

async function resolveAndRedirect(
  tabId: number,
  ensName: string,
  path: string,
  search: string,
  hash: string,
  opts: { bypassHelios?: boolean } = {},
) {
  const result = await resolveEns(ensName, opts);
  if (!result.ok) {
    await chrome.tabs.update(tabId, {
      url: errorPageUrl(ensName, result.error),
    });
    return;
  }
  const target = buildSubdomainUrl(result.kind, result.value, path || "/", search, hash);
  const ctx: TabContext = {
    ensName: result.ensName,
    kind: result.kind,
    value: result.value,
    path: path + search + hash,
    trustedDirectly: result.trustedDirectly,
  };
  await chrome.storage.session.set({ [`tab:${tabId}`]: ctx });
  await chrome.tabs.update(tabId, { url: target });
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (!ETH_HOST_RE.test(url.hostname)) return;

  const ensName = url.hostname.replace(/\.$/, "").toLowerCase();
  const pathname = url.pathname || "/";

  const { rpcUrls } = await getSettings();
  if (rpcUrls.length === 0) {
    await chrome.tabs.update(details.tabId, {
      url: errorPageUrl(
        ensName,
        "No Ethereum RPC configured. Open extension settings and add at least one execution RPC.",
      ),
    });
    return;
  }

  // Kick off Helios boot (no-op if already booting/synced). Don't block on it
  // here — if not synced yet, we redirect to the interstitial and let it wait.
  getOrStartHelios().catch((e) => {
    console.warn("[local-eth-limo] helios boot background err", e);
  });

  let status;
  try {
    status = await getHeliosStatus();
  } catch (e) {
    await chrome.tabs.update(details.tabId, {
      url: errorPageUrl(
        ensName,
        `Could not reach Helios offscreen doc: ${e instanceof Error ? e.message : String(e)}`,
      ),
    });
    return;
  }

  if (status.state === "synced") {
    await resolveAndRedirect(
      details.tabId,
      ensName,
      pathname,
      url.search,
      url.hash,
    );
    return;
  }

  // Not synced yet — hand off to interstitial.
  await chrome.tabs.update(details.tabId, {
    url: interstitialUrl(ensName, pathname, url.search, url.hash),
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(`tab:${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "get-tab-ctx") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ctx: null });
      return false;
    }
    chrome.storage.session.get(`tab:${tabId}`).then((res) => {
      sendResponse({ ctx: res[`tab:${tabId}`] ?? null });
    });
    return true;
  }

  if (msg?.type === "interstitial-retry") {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId == null) {
      sendResponse({ ok: false, error: "no tabId" });
      return false;
    }
    resolveAndRedirect(
      tabId,
      String(msg.name),
      String(msg.path ?? "/"),
      String(msg.search ?? ""),
      String(msg.hash ?? ""),
      { bypassHelios: !!msg.bypassHelios },
    ).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
    );
    return true;
  }

  if (msg?.type === "get-helios-status") {
    getHeliosStatus().then(
      (status) => sendResponse({ ok: true, status }),
      (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
    );
    return true;
  }

  if (msg?.type === "probe-rpc" && typeof msg.url === "string") {
    probeRpc(msg.url).then(
      (res) => sendResponse(res),
      (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
    );
    return true;
  }

  if (msg?.type === "shutdown-helios") {
    shutdownHelios().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === "open-options") {
    (async () => {
      const s = await getSettings();
      if (!s.onboardingComplete && s.rpcUrls.length === 0) {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("src/onboarding/onboarding.html"),
        });
      } else {
        await chrome.runtime.openOptionsPage();
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[local-eth-limo] installed");
  getOrStartHelios().catch(() => {
    /* no RPC yet is fine */
  });
  if (details.reason === "install") {
    const s = await getSettings();
    if (!s.onboardingComplete) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/onboarding/onboarding.html"),
      });
    }
  }
});

// When the active execution RPC changes (user reorders / removes / adds a new
// primary), tear down Helios so the next resolve boots it against the new URL.
let activePrimaryRpc: string | undefined;
getSettings().then((s) => {
  activePrimaryRpc = s.rpcUrls[0];
});
onSettingsChanged((s) => {
  const next = s.rpcUrls[0];
  if (next !== activePrimaryRpc) {
    activePrimaryRpc = next;
    shutdownHelios()
      .then(() => getOrStartHelios().catch(() => undefined))
      .catch(() => undefined);
  }
});

chrome.runtime.onStartup.addListener(() => {
  getOrStartHelios().catch(() => {
    /* no RPC yet is fine */
  });
});
