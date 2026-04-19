import "@/lib/sw-dom-shim";
import { resolveEns, getOrStartHelios, probeRpc } from "@/lib/resolver";
import { buildSubdomainUrl } from "@/lib/gateway";
import { getHeliosStatus, shutdownHelios } from "@/lib/helios-client";
import { getSettings, onSettingsChanged } from "@/lib/settings";
import type { TabContext } from "@/lib/messaging";

const ETH_HOST_RE = /^(?:[a-z0-9-]+\.)+eth\.?$/i;

// Dynamic DNR rule ID for the .eth → interstitial redirect. Must not collide
// with the static rules in public/rules/no_https_upgrade.json (which use 1, 2).
const ETH_REDIRECT_RULE_ID = 1001;

function errorPageUrl(name: string, error: string): string {
  const u = new URL(chrome.runtime.getURL("src/error/error.html"));
  u.searchParams.set("name", name);
  u.searchParams.set("error", error);
  return u.toString();
}

async function installEthRedirectRule() {
  // The interstitial is a web-accessible resource, so DNR can redirect to it.
  // We use regexSubstitution to stash the *entire* original URL into the
  // fragment of the redirect target. Fragments tolerate arbitrary chars
  // (including further `#` and `?`), so the interstitial can recover the
  // original URL verbatim via `location.hash.slice(1)` — no encoding needed.
  //
  // NB: DNR redirects require host permission for the *target URL of the
  // request*. That's why manifest.config.ts lists `*://*.eth/*` under
  // host_permissions. Without it this rule silently no-ops and Chrome's DNS
  // probe wins the race.
  const interstitial = chrome.runtime.getURL("src/interstitial/interstitial.html");
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ETH_REDIRECT_RULE_ID],
    addRules: [
      {
        id: ETH_REDIRECT_RULE_ID,
        priority: 2,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: { regexSubstitution: `${interstitial}#\\0` },
        },
        condition: {
          // Any *.eth host (first-level or subdomain), any scheme/port, any path/query/fragment.
          regexFilter: "^https?://(?:[a-z0-9-]+\\.)+eth(?::\\d+)?(?:/.*)?$",
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          ],
        },
      },
    ],
  });
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

// Ensure the DNR rule is registered on every SW wake-up. Dynamic rules persist
// across restarts, but this keeps the rule in sync if the extension URL has
// changed (e.g. reload during unpacked dev) and is a cheap no-op otherwise.
installEthRedirectRule().then(
  () => console.log("[local-eth-limo] .eth DNR redirect rule installed"),
  (e) => console.warn("[local-eth-limo] failed to install .eth DNR rule", e),
);

// DNR handles the *.eth → interstitial redirect synchronously at the network
// layer, beating Chrome's DNS-failure page. This listener just pre-boots
// Helios so it has a head start by the time the interstitial polls it.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (!ETH_HOST_RE.test(url.hostname)) return;
  getOrStartHelios().catch(() => undefined);
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

  if (msg?.type === "boot-helios") {
    getOrStartHelios().then(
      (status) => sendResponse({ ok: true, status }),
      (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
    );
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
  installEthRedirectRule().catch((e) => {
    console.warn("[local-eth-limo] failed to install .eth DNR rule", e);
  });
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
  installEthRedirectRule().catch((e) => {
    console.warn("[local-eth-limo] failed to install .eth DNR rule", e);
  });
  getOrStartHelios().catch(() => {
    /* no RPC yet is fine */
  });
});
