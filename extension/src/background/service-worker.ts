import "@/lib/sw-dom-shim";
import {
  resolveContractAddress,
  resolveEns,
  getOrStartHelios,
} from "@/lib/resolver";
import { buildSubdomainUrl, parseGatewayHost } from "@/lib/gateway";
import { getHeliosStatus, shutdownHelios } from "@/lib/helios-client";
import { getSettings, onSettingsChanged } from "@/lib/settings";
import type {
  ContentUpdatedMessage,
  ResolveKind,
  TabContext,
} from "@/lib/messaging";
import { findCachedByGatewayLabel, getCached, setCached } from "@/lib/cache";
import {
  bumpWeb3LastAccess,
  getWeb3CacheEntry,
  listWeb3Entries,
  removeWeb3CacheEntry,
  mfsPathFor,
} from "@/lib/web3url-cache";
import { removeMfsPath, unpinFromKubo } from "@/lib/kubo";

const ETH_HOST_RE = /^(?:[a-z0-9-]+\.)+eth\.?$/i;
const W3ETH_HOST_RE = /^0x[a-f0-9]{40}\.w3eth\.io\.?$/i;
const ADDRESS_RE = /^0x[a-f0-9]{40}$/i;

// Dynamic DNR rule IDs. Must not collide with the static rules in
// public/rules/no_https_upgrade.json (which use 1, 2).
const ETH_REDIRECT_RULE_ID = 1001;
const ETH_LIMO_REDIRECT_RULE_ID = 1002;
// Session-scoped ALLOW rule that punches through the eth.limo/link redirect
// for specific tabs. Lets the banner's "Open on eth.limo" action reach the
// public gateway even when interception is on. Session rules are evicted on
// browser shutdown, so there's no cross-session leak.
const ETH_LIMO_BYPASS_RULE_ID = 1003;
// Catches `https?://0x<addr>.w3eth.io[/path]` and rewrites to the interstitial
// with the original URL stashed in the fragment. Same shape as the .eth rule:
// the interstitial recovers the URL via location.hash and parses the contract
// address out of the hostname. Toggle: settings.interceptW3Eth.
const W3ETH_REDIRECT_RULE_ID = 1004;
// Session-scoped ALLOW rule that punches through the w3eth.io DNR redirect
// for specific tabs. Mirrors ETH_LIMO_BYPASS_RULE_ID but for w3eth.io. Used
// when the user clicks "Open on w3eth.io" in the banner menu — they want the
// public gateway, not local resolution. The in-memory `w3EthBypassTabs` Set
// below covers the JS-layer redirect (onBeforeNavigate); the DNR rule covers
// the network-layer redirect for browsers where that one fires.
const W3ETH_BYPASS_RULE_ID = 1005;

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

async function syncW3EthRedirectRule(enabled: boolean) {
  // Rewrites `https?://0x<40hex>.w3eth.io[:port][/path]` → the interstitial,
  // with the original URL preserved in the fragment so the page can recover
  // the contract address and resolve via local Helios + Kubo. The fragment
  // form mirrors the .eth rule exactly so interstitial.ts has one parse path.
  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [W3ETH_REDIRECT_RULE_ID],
    });
    return;
  }
  // Sanity check: the redirect silently no-ops without host access to the
  // request URL. For unpacked installs that pre-date the manifest update, the
  // user may need to remove + re-load the extension to pick up the new host.
  try {
    const has = await chrome.permissions.contains({
      origins: ["*://*.w3eth.io/*"],
    });
    if (!has) {
      console.warn(
        "[dapp3] missing *://*.w3eth.io/* host permission — w3eth.io redirect will no-op." +
          " Remove and re-load the unpacked extension to grant the new host.",
      );
    }
  } catch {
    /* permissions.contains may not be available; fall through */
  }
  const interstitial = chrome.runtime.getURL("interstitial.html");
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [W3ETH_REDIRECT_RULE_ID],
    addRules: [
      {
        id: W3ETH_REDIRECT_RULE_ID,
        priority: 2,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: { regexSubstitution: `${interstitial}#\\0` },
        },
        condition: {
          regexFilter:
            "^https?://0x[a-f0-9]{40}\\.w3eth\\.io(?::\\d+)?(?:/.*)?$",
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

// When onboarding isn't complete we unset the popup (`setPopup('')`) so that
// clicking the toolbar icon fires `action.onClicked` instead of opening the
// popup — the listener below then opens (or focuses) the onboarding tab. The
// moment onboarding completes the popup is restored.
async function syncActionPopup(onboardingComplete: boolean) {
  try {
    await chrome.action.setPopup({
      popup: onboardingComplete ? "popup.html" : "",
    });
  } catch (e) {
    console.warn("[dapp3] setPopup failed", e);
  }
}

async function focusOrOpenOnboarding() {
  const url = chrome.runtime.getURL("onboarding.html");
  const existing = await chrome.tabs.query({ url });
  const tab = existing[0];
  if (tab?.id != null) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url });
}

// Only fires when `setPopup('')` is active — i.e. while onboarding is pending.
chrome.action.onClicked.addListener(() => {
  focusOrOpenOnboarding().catch((e) =>
    console.warn("[dapp3] failed to open onboarding", e),
  );
});

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

// Bypass set for the JS-layer w3eth.io redirect (the one in onBeforeNavigate
// below). In-memory only — survives within an SW lifetime, lost on restart.
// Combined with the session DNR ALLOW rule below, the SW restart edge case
// only loses the JS layer; the DNR rule keeps holding through the restart.
const w3EthBypassTabs = new Set<number>();

async function setW3EthBypassDnrTabs(tabIds: number[]) {
  if (tabIds.length === 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [W3ETH_BYPASS_RULE_ID],
    });
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [W3ETH_BYPASS_RULE_ID],
    addRules: [
      {
        id: W3ETH_BYPASS_RULE_ID,
        priority: 3,
        action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
        condition: {
          regexFilter:
            "^https?://0x[a-f0-9]{40}\\.w3eth\\.io(?::\\d+)?(?:/.*)?$",
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          ],
          tabIds,
        },
      },
    ],
  });
}

async function getW3EthBypassDnrTabs(): Promise<number[]> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === W3ETH_BYPASS_RULE_ID);
  return (rule?.condition.tabIds as number[] | undefined) ?? [];
}

async function addW3EthBypassForTab(tabId: number) {
  // Sync in-memory add must happen first and unconditionally — it's what
  // actually gates the JS-layer onBeforeNavigate redirect. The DNR rule
  // install below is best-effort defense-in-depth for browsers where the
  // network-layer redirect rule fires; if it throws (rule shape rejected,
  // session-rule cap hit, etc.) we don't want to abort the navigation.
  w3EthBypassTabs.add(tabId);
  try {
    const current = await getW3EthBypassDnrTabs();
    if (current.includes(tabId)) return;
    await setW3EthBypassDnrTabs([...current, tabId]);
  } catch (e) {
    console.warn(
      "[dapp3] w3eth.io DNR bypass install failed; JS bypass still in effect",
      e,
    );
  }
}

async function removeW3EthBypassForTab(tabId: number) {
  w3EthBypassTabs.delete(tabId);
  try {
    const current = await getW3EthBypassDnrTabs();
    if (!current.includes(tabId)) return;
    await setW3EthBypassDnrTabs(current.filter((id) => id !== tabId));
  } catch {
    /* best-effort cleanup */
  }
}

// Repopulate the in-memory set from session DNR state on SW boot. The session
// rules survive SW restart even though the in-memory Set doesn't, so this
// keeps the two layers in sync.
getW3EthBypassDnrTabs()
  .then((tabs) => {
    for (const id of tabs) w3EthBypassTabs.add(id);
  })
  .catch(() => undefined);

async function resolveAndRedirect(
  tabId: number,
  ensName: string,
  path: string,
  search: string,
  hash: string,
  opts: { bypassHelios?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  // The "ensName" parameter is a generic resolution target — either a `.eth`
  // name or a 0x contract address (from w3eth.io interception or homepage).
  const result = ADDRESS_RE.test(ensName)
    ? await resolveContractAddress(ensName, opts)
    : await resolveEns(ensName, opts);
  if (!result.ok) {
    // Kubo CORS rejection is a one-time setup issue, not a per-site failure.
    // Don't navigate the tab — return the code so the interstitial can
    // render the setup card inline and keep the address-bar context. See
    // PRD_ERC4804.md §4.1 / §6.1.
    if (result.code === "kubo-cors-blocked") {
      return { ok: false, error: result.error, code: result.code };
    }
    await chrome.tabs.update(tabId, {
      url: errorPageUrl(ensName, result.error, path, search, hash),
    });
    return { ok: false, error: result.error };
  }
  const target = buildSubdomainUrl(result.kind, result.value, path || "/", search, hash);
  const ctx: TabContext = {
    ensName: result.ensName,
    kind: result.kind,
    value: result.value,
    path: path + search + hash,
    trustedDirectly: result.trustedDirectly,
    contractAddress: result.contractAddress,
  };
  await chrome.storage.session.set({ [`tab:${tabId}`]: ctx });
  // Only cache Helios-verified resolutions. Bypass-trusted results carry a
  // weaker trust contract. Web3 entries are also cached here so the next
  // visit redirects synchronously from the ENS name to the same CID; the
  // per-contract sha256 cache (web3url-cache.ts) handles content freshness
  // separately, and refreshFromCache below performs the revalidation.
  if (!result.trustedDirectly) {
    await setCached({
      ensName: result.ensName,
      kind: result.kind,
      value: result.value,
      resolvedAt: Date.now(),
      contractAddress: result.contractAddress,
    }).catch((e) => console.warn("[dapp3] cache write failed", e));
  }
  await chrome.tabs.update(tabId, { url: target });
  return { ok: true };
}

// Background re-resolve after a cache-hit navigation. If the verified
// contenthash (or in the web3 path, the CID derived from re-pinning fresh
// bytes) differs from what we just served, update the cache, the
// session-storage TabContext (so a future hydrate sees fresh values), and
// notify the banner so it can offer the user a one-click reload.
//
// Per-contract revalidation is rate-limited via web3RevalidateMinIntervalMs:
// repeated visits inside the window skip the eth_call entirely and just bump
// lastAccess. This keeps Helios load light when a user clicks around a
// multi-page web3 dapp that triggers many same-contract resolves.
const DEFAULT_WEB3_REVALIDATE_MIN_INTERVAL_MS = 30_000;

async function refreshFromCache(
  tabId: number,
  ensName: string,
  path: string,
  search: string,
  hash: string,
  cachedEntry: { kind: ResolveKind; value: string; contractAddress?: `0x${string}` },
) {
  // Web3 rate-limit: skip the eth_call if we just revalidated this contract.
  if (cachedEntry.kind === "web3" && cachedEntry.contractAddress) {
    const [s, entry] = await Promise.all([
      getSettings(),
      getWeb3CacheEntry(cachedEntry.contractAddress),
    ]);
    const interval =
      s.web3RevalidateMinIntervalMs ?? DEFAULT_WEB3_REVALIDATE_MIN_INTERVAL_MS;
    if (entry && Date.now() - entry.lastAccess < interval) {
      bumpWeb3LastAccess(cachedEntry.contractAddress).catch(() => undefined);
      return;
    }
  }

  let result;
  try {
    result = ADDRESS_RE.test(ensName)
      ? await resolveContractAddress(ensName)
      : await resolveEns(ensName);
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

  // The fresh resolve always rewrites the ENS-keyed cache (it's authoritative
  // for first paint on the next visit) regardless of whether the value
  // changed — bumps resolvedAt and picks up any contract-address shifts.
  await setCached({
    ensName: result.ensName,
    kind: result.kind,
    value: result.value,
    resolvedAt: Date.now(),
    contractAddress: result.contractAddress,
  }).catch(() => undefined);

  if (result.value === cachedEntry.value) {
    // Same content. Done — just leave the timestamp bump above.
    return;
  }
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
    contractAddress: result.contractAddress,
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
getSettings().then((s) => {
  console.log(
    "[dapp3] booting with intercept toggles:",
    "ethLimo=",
    s.interceptEthLimo,
    "w3eth=",
    s.interceptW3Eth,
  );
  syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
    console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
  );
  syncW3EthRedirectRule(s.interceptW3Eth).then(
    () =>
      console.log(
        "[dapp3] w3eth.io DNR rule",
        s.interceptW3Eth ? "installed" : "removed",
      ),
    (e) => console.warn("[dapp3] failed to sync w3eth.io DNR rule", e),
  );
  syncActionPopup(!!s.onboardingComplete);
});

// DNR handles the *.eth → interstitial redirect synchronously at the network
// layer, beating Chrome's DNS-failure page. This listener pre-boots Helios so
// it has a head start by the time the interstitial polls it. It also acts as
// a JS-layer fallback for w3eth.io interception: the DNR rule for w3eth.io
// has proven unreliable in practice (silently no-ops in some Chrome setups
// even with proper host_permissions), so we always issue the tabs.update
// redirect here too. If DNR happened to fire as well, both target the same
// interstitial URL — the race is idempotent.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  const isEth = ETH_HOST_RE.test(url.hostname);
  const isW3Eth = W3ETH_HOST_RE.test(url.hostname);
  if (!isEth && !isW3Eth) return;
  getOrStartHelios().catch(() => undefined);
  if (
    isW3Eth &&
    activeInterceptW3Eth !== false &&
    !w3EthBypassTabs.has(details.tabId)
  ) {
    const interstitial = chrome.runtime.getURL("interstitial.html");
    const target = `${interstitial}#${details.url}`;
    chrome.tabs
      .update(details.tabId, { url: target })
      .catch((e) =>
        console.warn("[dapp3] w3eth.io fallback redirect failed", e),
      );
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(`tab:${tabId}`);
  await removeEthLimoBypassForTab(tabId).catch(() => undefined);
  await removeW3EthBypassForTab(tabId).catch(() => undefined);
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
      // Address-mode (w3eth.io / homepage 0x input): look up the per-contract
      // cache rather than the ENS-keyed one. The synthetic cache entry below
      // gives the rest of the flow (TabContext, refreshFromCache) the same
      // shape it expects in ENS mode.
      let hit: {
        ensName: string;
        kind: ResolveKind;
        value: string;
        contractAddress?: `0x${string}`;
      } | null = null;
      if (ADDRESS_RE.test(name)) {
        const entry = await getWeb3CacheEntry(name as `0x${string}`).catch(
          () => null,
        );
        if (entry) {
          hit = {
            ensName: name,
            kind: "web3",
            value: entry.cid,
            contractAddress: entry.contractAddress,
          };
        }
      } else {
        const c = await getCached(name).catch(() => null);
        if (c) {
          hit = {
            ensName: c.ensName,
            kind: c.kind,
            value: c.value,
            contractAddress: c.contractAddress,
          };
        }
      }
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
        contractAddress: hit.contractAddress,
        fromCache: true,
      };
      await chrome.storage.session.set({ [`tab:${tabId}`]: ctx });
      sendResponse({ cached: true, gatewayUrl });
      // Kick off the background re-resolve. Helios was pre-warmed in
      // onBeforeNavigate; if it isn't synced yet the resolve will fail and
      // we'll silently skip the freshness check until next visit.
      refreshFromCache(tabId, name, path, search, hash, {
        kind: hit.kind,
        value: hit.value,
        contractAddress: hit.contractAddress,
      }).catch((e) => console.warn("[dapp3] refreshFromCache threw", e));
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
      (result) => sendResponse(result),
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

  if (msg?.type === "open-on-w3eth" && typeof msg.url === "string") {
    const tabId = sender.tab?.id;
    const url = msg.url as string;
    if (tabId == null) {
      sendResponse({ ok: false, error: "no tabId" });
      return false;
    }
    // Sync bypass set first so onBeforeNavigate skips the JS redirect when the
    // tabs.update below fires its event. DNR rule install is fire-and-forget
    // (defense-in-depth) and must not block the navigation.
    w3EthBypassTabs.add(tabId);
    addW3EthBypassForTab(tabId).catch(() => undefined);
    chrome.tabs.update(tabId, { url }).then(
      () => sendResponse({ ok: true }),
      (e) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
    );
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

  if (msg?.type === "open-home") {
    (async () => {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("home.html"),
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "web3-list") {
    listWeb3Entries().then(
      (entries) => sendResponse({ ok: true, entries }),
      (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
    );
    return true;
  }

  if (msg?.type === "web3-evict" && typeof msg.contractAddress === "string") {
    const addr = msg.contractAddress as `0x${string}`;
    (async () => {
      const entry = await getWeb3CacheEntry(addr);
      if (!entry) {
        sendResponse({ ok: true, evicted: false });
        return;
      }
      try {
        await Promise.allSettled([
          unpinFromKubo(entry.cid),
          removeMfsPath(mfsPathFor(entry.contractAddress, entry.contentHash)),
        ]);
        await removeWeb3CacheEntry(entry.contractAddress);
        sendResponse({ ok: true, evicted: true });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return true;
  }

  if (msg?.type === "open-options") {
    (async () => {
      const s = await getSettings();
      if (!s.onboardingComplete && !s.rpcUrl) {
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
  getSettings().then((s) => {
    syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
      console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
    );
    syncW3EthRedirectRule(s.interceptW3Eth).catch((e) =>
      console.warn("[dapp3] failed to sync w3eth.io DNR rule", e),
    );
    syncActionPopup(!!s.onboardingComplete);
  });
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

// When the execution RPC changes, tear down Helios so the next resolve boots
// it against the new URL. Also keep the eth.limo DNR rule in sync with the
// user's preference.
let activeRpc: string | undefined;
let activeInterceptEthLimo: boolean | undefined;
let activeInterceptW3Eth: boolean | undefined;
let activeOnboardingComplete: boolean | undefined;
getSettings().then((s) => {
  activeRpc = s.rpcUrl;
  activeInterceptEthLimo = s.interceptEthLimo;
  activeInterceptW3Eth = s.interceptW3Eth;
  activeOnboardingComplete = !!s.onboardingComplete;
});
onSettingsChanged((s) => {
  const next = s.rpcUrl;
  if (next !== activeRpc) {
    activeRpc = next;
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
  if (s.interceptW3Eth !== activeInterceptW3Eth) {
    activeInterceptW3Eth = s.interceptW3Eth;
    syncW3EthRedirectRule(s.interceptW3Eth).catch((e) =>
      console.warn("[dapp3] failed to sync w3eth.io DNR rule", e),
    );
  }
  const onboarded = !!s.onboardingComplete;
  if (onboarded !== activeOnboardingComplete) {
    activeOnboardingComplete = onboarded;
    syncActionPopup(onboarded);
  }
});

chrome.runtime.onStartup.addListener(() => {
  installEthRedirectRule().catch((e) => {
    console.warn("[dapp3] failed to install .eth DNR rule", e);
  });
  getSettings().then((s) => {
    syncEthLimoRedirectRule(s.interceptEthLimo).catch((e) =>
      console.warn("[dapp3] failed to sync eth.limo DNR rule", e),
    );
    syncW3EthRedirectRule(s.interceptW3Eth).catch((e) =>
      console.warn("[dapp3] failed to sync w3eth.io DNR rule", e),
    );
    syncActionPopup(!!s.onboardingComplete);
  });
  getOrStartHelios().catch(() => {
    /* no RPC yet is fine */
  });
});
