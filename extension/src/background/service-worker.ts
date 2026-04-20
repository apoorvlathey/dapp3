import "@/lib/sw-dom-shim";
import { resolveEns, getOrStartHelios, probeRpc } from "@/lib/resolver";
import { buildSubdomainUrl, parseGatewayHost } from "@/lib/gateway";
import { getHeliosStatus, shutdownHelios } from "@/lib/helios-client";
import { getSettings, onSettingsChanged } from "@/lib/settings";
import type { ContentUpdatedMessage, TabContext } from "@/lib/messaging";
import { findCachedByGatewayLabel, getCached, setCached } from "@/lib/cache";

const ETH_HOST_RE = /^(?:[a-z0-9-]+\.)+eth\.?$/i;

// Dynamic DNR rule IDs. Must not collide with the static rules in
// public/rules/no_https_upgrade.json (which use 1, 2).
const ETH_REDIRECT_RULE_ID = 1001;
const ETH_LIMO_REDIRECT_RULE_ID = 1002;
// Session-scoped ALLOW rule that punches through the eth.limo/link redirect
// for specific tabs. Lets the banner's "Open on eth.limo" action reach the
// public gateway even when interception is on. Session rules are evicted on
// browser shutdown, so there's no cross-session leak.
const ETH_LIMO_BYPASS_RULE_ID = 1003;

function errorPageUrl(
  name: string,
  error: string,
  path = "/",
  search = "",
  hash = "",
): string {
  const u = new URL(chrome.runtime.getURL("error.html"));
  u.searchParams.set("name", name);
  u.searchParams.set("error", error);
  // Path/search/hash are needed so the eth.limo fallback link the error page
  // renders preserves the original target — otherwise a failed resolve of
  // `foo.eth/some/path` would only offer `foo.eth.limo/`.
  if (path && path !== "/") u.searchParams.set("path", path);
  if (search) u.searchParams.set("search", search);
  if (hash) u.searchParams.set("hash", hash);
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
  const interstitial = chrome.runtime.getURL("interstitial.html");
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

async function syncEthLimoRedirectRule(enabled: boolean) {
  // Rewrites `https?://<label>.eth.(limo|link)[:port][/path]` →
  // `http://<label>.eth[/path]`. The existing .eth rule then catches the
  // result and routes through the interstitial → resolver → gateway flow,
  // so the user gets local Helios-verified content instead of the public
  // (and currently flaky / WAF-403-ing) eth.limo / eth.link gateways.
  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ETH_LIMO_REDIRECT_RULE_ID],
    });
    return;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ETH_LIMO_REDIRECT_RULE_ID],
    addRules: [
      {
        id: ETH_LIMO_REDIRECT_RULE_ID,
        // Must be lower than the .eth rule's priority so the redirected
        // request flows through the .eth rule on the next pass. (DNR
        // priorities only matter for *competing* rules on the same request,
        // but keeping these distinct makes the chain easier to reason about.)
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: { regexSubstitution: "http://\\1.eth\\2" },
        },
        condition: {
          regexFilter:
            "^https?://([a-z0-9-]+(?:\\.[a-z0-9-]+)*)\\.eth\\.(?:limo|link)(?::\\d+)?(/.*)?$",
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          ],
        },
      },
    ],
  });
}

async function setEthLimoBypassTabs(tabIds: number[]) {
  if (tabIds.length === 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ETH_LIMO_BYPASS_RULE_ID],
    });
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ETH_LIMO_BYPASS_RULE_ID],
    addRules: [
      {
        id: ETH_LIMO_BYPASS_RULE_ID,
        // Higher than both the .eth redirect (2) and the eth.limo redirect (1)
        // so an eth.limo main_frame request on a bypassed tab wins the ALLOW
        // and reaches the real public gateway.
        priority: 3,
        action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
        condition: {
          regexFilter:
            "^https?://([a-z0-9-]+(?:\\.[a-z0-9-]+)*)\\.eth\\.(?:limo|link)(?::\\d+)?(/.*)?$",
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          ],
          tabIds,
        },
      },
    ],
  });
}

async function getEthLimoBypassTabs(): Promise<number[]> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === ETH_LIMO_BYPASS_RULE_ID);
  return (rule?.condition.tabIds as number[] | undefined) ?? [];
}

async function addEthLimoBypassForTab(tabId: number) {
  const current = await getEthLimoBypassTabs();
  if (current.includes(tabId)) return;
  await setEthLimoBypassTabs([...current, tabId]);
}

async function removeEthLimoBypassForTab(tabId: number) {
  const current = await getEthLimoBypassTabs();
  if (!current.includes(tabId)) return;
  await setEthLimoBypassTabs(current.filter((id) => id !== tabId));
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
      url: errorPageUrl(ensName, result.error, path, search, hash),
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
  // Only cache Helios-verified resolutions. Bypass-trusted results carry a
  // weaker trust contract and shouldn't be served silently on later visits.
  if (!result.trustedDirectly) {
    await setCached({
      ensName: result.ensName,
      kind: result.kind,
      value: result.value,
      resolvedAt: Date.now(),
    }).catch((e) => console.warn("[dapp3] cache write failed", e));
  }
  await chrome.tabs.update(tabId, { url: target });
}

// Background re-resolve after a cache-hit navigation. If the verified
// contenthash differs from what we just served, update the cache, the
// session-storage TabContext (so a future hydrate sees fresh values), and
// notify the banner so it can offer the user a one-click reload.
async function refreshFromCache(
  tabId: number,
  ensName: string,
  path: string,
  search: string,
  hash: string,
  cachedValue: string,
) {
  let result;
  try {
    result = await resolveEns(ensName);
  } catch (e) {
    console.warn("[dapp3] background refresh failed", e);
    return;
  }
  if (!result.ok) {
    // Not fatal — the cached page is still working. A subsequent visit will
    // try again.
    console.log(
      `[dapp3] background refresh of ${ensName} failed: ${result.error}`,
    );
    return;
  }
  if (result.value === cachedValue) {
    // Cache is still fresh; nothing to do beyond bumping the timestamp.
    await setCached({
      ensName: result.ensName,
      kind: result.kind,
      value: result.value,
      resolvedAt: Date.now(),
    }).catch(() => undefined);
    return;
  }
  await setCached({
    ensName: result.ensName,
    kind: result.kind,
    value: result.value,
    resolvedAt: Date.now(),
  }).catch(() => undefined);
  const newGateway = buildSubdomainUrl(
    result.kind,
    result.value,
    path || "/",
    search,
    hash,
  );
  // Update the session ctx so the banner's next hydrate (e.g. after the user
  // accepts the reload) reflects the new value, not the stale cached one.
  const fresh: TabContext = {
    ensName: result.ensName,
    kind: result.kind,
    value: result.value,
    path: path + search + hash,
    trustedDirectly: false,
  };
  await chrome.storage.session.set({ [`tab:${tabId}`]: fresh });
  const msg: ContentUpdatedMessage = {
    type: "content-updated",
    ensName: result.ensName,
    kind: result.kind,
    value: result.value,
    gatewayUrl: newGateway,
  };
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Banner content script may not be listening yet (page still loading);
    // it'll request the latest ctx from session storage on init.
  });
}

// Ensure the DNR rules are registered on every SW wake-up. Dynamic rules
// persist across restarts, but this keeps them in sync if the extension URL
// has changed (e.g. reload during unpacked dev) and the user's eth.limo
// preference may have flipped.
installEthRedirectRule().then(
  () => console.log("[dapp3] .eth DNR redirect rule installed"),
  (e) => console.warn("[dapp3] failed to install .eth DNR rule", e),
);
getSettings().then((s) =>
  syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
    console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
  ),
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
  await removeEthLimoBypassForTab(tabId).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "get-tab-ctx") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ctx: null });
      return false;
    }
    (async () => {
      const stored = (await chrome.storage.session.get(`tab:${tabId}`))[
        `tab:${tabId}`
      ] as TabContext | undefined;
      if (stored) {
        sendResponse({ ctx: stored });
        return;
      }
      // No ctx from our resolve flow — user likely navigated straight to a
      // gateway URL (bookmark, shared link, manually typed CID). Try to
      // reverse-lookup the ENS name from the cache so the banner can still
      // show the identity instead of staying invisible.
      const senderUrl = sender.tab?.url ?? sender.url;
      if (!senderUrl) {
        sendResponse({ ctx: null });
        return;
      }
      let u: URL;
      try {
        u = new URL(senderUrl);
      } catch {
        sendResponse({ ctx: null });
        return;
      }
      const parsed = parseGatewayHost(u.hostname);
      if (!parsed) {
        sendResponse({ ctx: null });
        return;
      }
      const hit = await findCachedByGatewayLabel(
        parsed.kind,
        parsed.label,
      ).catch(() => null);
      if (!hit) {
        sendResponse({ ctx: null });
        return;
      }
      const ctx: TabContext = {
        ensName: hit.ensName,
        kind: hit.kind,
        value: hit.value,
        path: u.pathname + u.search + u.hash,
        trustedDirectly: false,
      };
      sendResponse({ ctx });
    })();
    return true;
  }

  if (msg?.type === "interstitial-cache-check") {
    const tabId = sender.tab?.id ?? msg.tabId;
    const name = String(msg.name ?? "").toLowerCase();
    const path = String(msg.path ?? "/");
    const search = String(msg.search ?? "");
    const hash = String(msg.hash ?? "");
    if (tabId == null || !name) {
      sendResponse({ cached: false });
      return false;
    }
    (async () => {
      const hit = await getCached(name).catch(() => null);
      if (!hit) {
        sendResponse({ cached: false });
        return;
      }
      const gatewayUrl = buildSubdomainUrl(
        hit.kind,
        hit.value,
        path || "/",
        search,
        hash,
      );
      const ctx: TabContext = {
        ensName: hit.ensName,
        kind: hit.kind,
        value: hit.value,
        path: path + search + hash,
        trustedDirectly: false,
        fromCache: true,
      };
      await chrome.storage.session.set({ [`tab:${tabId}`]: ctx });
      sendResponse({ cached: true, gatewayUrl });
      // Kick off the background re-resolve. Helios was pre-warmed in
      // onBeforeNavigate; if it isn't synced yet the resolve will fail and
      // we'll silently skip the freshness check until next visit.
      refreshFromCache(tabId, name, path, search, hash, hit.value).catch(
        (e) => console.warn("[dapp3] refreshFromCache threw", e),
      );
    })();
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

  if (msg?.type === "open-on-eth-limo" && typeof msg.url === "string") {
    const tabId = sender.tab?.id;
    const url = msg.url as string;
    if (tabId == null) {
      sendResponse({ ok: false, error: "no tabId" });
      return false;
    }
    (async () => {
      try {
        // Install the per-tab ALLOW override *before* navigating so the DNR
        // engine sees it in place by the time the main_frame request fires.
        await addEthLimoBypassForTab(tabId);
        await chrome.tabs.update(tabId, { url });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return true;
  }

  if (msg?.type === "open-bookmarks") {
    (async () => {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("bookmarks.html"),
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "open-options") {
    (async () => {
      const s = await getSettings();
      if (!s.onboardingComplete && s.rpcUrls.length === 0) {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("onboarding.html"),
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
  console.log("[dapp3] installed");
  installEthRedirectRule().catch((e) => {
    console.warn("[dapp3] failed to install .eth DNR rule", e);
  });
  getSettings().then((s) =>
    syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
      console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
    ),
  );
  getOrStartHelios().catch(() => {
    /* no RPC yet is fine */
  });
  if (details.reason === "install") {
    const s = await getSettings();
    if (!s.onboardingComplete) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("onboarding.html"),
      });
    }
  }
});

// When the active execution RPC changes (user reorders / removes / adds a new
// primary), tear down Helios so the next resolve boots it against the new URL.
// Also keep the eth.limo DNR rule in sync with the user's preference.
let activePrimaryRpc: string | undefined;
let activeInterceptEthLimo: boolean | undefined;
getSettings().then((s) => {
  activePrimaryRpc = s.rpcUrls[0];
  activeInterceptEthLimo = s.interceptEthLimo;
});
onSettingsChanged((s) => {
  const next = s.rpcUrls[0];
  if (next !== activePrimaryRpc) {
    activePrimaryRpc = next;
    shutdownHelios()
      .then(() => getOrStartHelios().catch(() => undefined))
      .catch(() => undefined);
  }
  if (s.interceptEthLimo !== activeInterceptEthLimo) {
    activeInterceptEthLimo = s.interceptEthLimo;
    syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
      console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
    );
  }
});

chrome.runtime.onStartup.addListener(() => {
  installEthRedirectRule().catch((e) => {
    console.warn("[dapp3] failed to install .eth DNR rule", e);
  });
  getSettings().then((s) =>
    syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
      console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
    ),
  );
  getOrStartHelios().catch(() => {
    /* no RPC yet is fine */
  });
});
