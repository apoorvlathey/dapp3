# Chrome Web Store Publishing Guide

This document contains all the information required for the Chrome Web Store Privacy practices tab.
Media assets are available in `./_docs/images/`

---

## Store Listing Description

### Short description (≤132 chars, shown in search results):

Open any .eth site trustlessly. Resolves ENS on your own Ethereum light client and loads the site from your local IPFS node.

### Long description (shown on the listing page):

dapp3.eth lets you open .eth websites in Chrome without trusting any gateway or RPC provider.

Type vitalik.eth in the address bar and dapp3.eth takes over: it looks up the ENS record on Ethereum mainnet using an Ethereum light client that runs locally inside the extension, gets the IPFS content hash for the site, and loads it from the IPFS node running on your own computer. No eth.limo. No ipfs.io. No third party in the middle.

== Why use it ==

- No trusted gateway. Public ENS/IPFS gateways see every .eth site you visit, can show you the wrong site, and can disappear overnight (as eth.limo did). dapp3.eth removes them from the path entirely.
- Verified against Ethereum itself. ENS lookups are verified by a built-in Helios light client, not taken on faith from an RPC provider.
- Served from your own machine. Content loads from the Kubo IPFS node running on your computer, which you control.
- Private by design. No analytics, no telemetry, no accounts. Every endpoint the extension talks to is either on your own device or one you picked yourself.

== What you need ==

- A running Kubo IPFS node on your machine (the extension walks you through this on first launch). See https://docs.ipfs.tech/install/command-line/
- An Ethereum execution RPC endpoint of your choice (any mainnet RPC works, your own node, Infura, Alchemy, etc.).

Open source at https://github.com/apoorvlathey/dapp3

---

## Single Purpose Description

**What does your extension do?**

dapp3.eth is a local-first, trust-minimized ENS gateway. It intercepts navigations to `*.eth` domains, resolves the ENS name and its contenthash directly against Ethereum state using an embedded Helios light client, and serves the resulting IPFS/IPNS content from the user's own locally-running Kubo node at `*.ipfs.localhost` / `*.ipns.localhost`. It is a replacement for public gateways like `eth.limo`, removing the trusted third party from the resolution and content-serving path.

---

## Permission Justifications

### 1. webNavigation

**Justification:**

The extension must observe top-level navigations to `*.eth` hostnames before Chrome's DNS resolver fails and surfaces the "site can't be reached" error page. Specifically:

1. `chrome.webNavigation.onBeforeNavigate` fires on every navigation. We filter on `frameId === 0` and hostnames matching the first-level `.eth` pattern.
2. Once matched, we asynchronously resolve the ENS name to a contenthash and redirect the tab to the local Kubo gateway URL.

`declarativeNetRequest` rules are synchronous and cannot wait on an RPC round-trip, so `webNavigation` is the only viable API for this interception.

---

### 2. tabs

**Justification:**

The tabs permission is used for two specific purposes:

1. Redirecting the intercepted navigation: After resolving an ENS name, the service worker calls `chrome.tabs.update(tabId, { url: gatewayUrl })` to send the tab to the resolved `<cid>.ipfs.localhost` or `<name>.ipns.localhost` URL.

2. Onboarding tab management: When the extension is first installed, it opens an onboarding page in a new tab. When onboarding is complete the extension can close that tab so the user is not left with an unused tab.

The extension does not read arbitrary tab content or URLs. It only inspects its own navigation events and updates URLs on tabs it has chosen to intercept.

---

### 3. storage

**Justification:**

The storage permission is essential for the extension to function. It is used to store:

1. User settings (in `chrome.storage.local`): the primary execution RPC URL, consensus RPC URL, and optional checkpoint hash used to bootstrap the Helios light client, plus feature toggles (e.g. whether to intercept `*.eth.limo` / `*.eth.link` mirror hostnames).
2. Bookmarks: per-URL bookmarks the user has starred from the banner on gateway pages.
3. ENS resolution cache: recent `name → contenthash` resolutions, with background refresh so repeat navigations are instant.
4. Per-tab navigation context (in `chrome.storage.session`): keyed by `tabId`, stores the original ENS name/path so the content-script banner on the gateway page can display it after the redirect. Cleared on browser restart.
5. Onboarding completion flag so the 4-step first-run wizard is not shown again.

---

### 4. offscreen

**Justification:**

The extension runs an Ethereum light client (Helios, compiled to WebAssembly) to verify chain state locally rather than trusting an RPC provider. MV3 service workers are terminated after ~30 seconds of inactivity, which would kill the light client's sync state and re-bootstrap on every request. The `chrome.offscreen` API hosts Helios in a long-lived offscreen document; the service worker communicates with it via `chrome.runtime.sendMessage`. Every `eth_call` performed by the ENS resolver is a message round-trip to this offscreen document.

This is the only supported way to run long-lived WASM workloads in MV3.

---

### 5. declarativeNetRequest

**Justification:**

Two narrow, static rule uses:

1. **HTTPS-upgrade bypass for `*.ipfs.localhost` and `*.ipns.localhost`:** Chrome's "Always use secure connections" setting would redirect `http://<cid>.ipfs.localhost` to HTTPS, which Kubo does not serve. A static DNR allow-rule at `public/rules/no_https_upgrade.json` prevents the upgrade so the redirect to the local gateway works.

2. **Optional `*.eth.limo` / `*.eth.link` rewriting:** When the user opts in, a DNR redirect rule rewrites `<name>.eth.limo` and `<name>.eth.link` to `<name>.eth` so they go through the local resolver instead of the public gateway.

No rules touch arbitrary third-party traffic.

---

### 6. Host Permissions

**Required host permissions:**

- `http://127.0.0.1/*`, `http://localhost/*`, `http://*.localhost/*` — the extension talks to the user's own locally-running Kubo IPFS node over these origins (`127.0.0.1:5001` for the API, `<cid>.ipfs.localhost:8080` for the gateway). No remote host.
- `*://*.eth/*` — required so the DNR redirect can intercept `*.eth` main-frame requests before Chrome's DNS probe shows the failure page. DNR redirects need host access to the target URL; without this, the rule silently no-ops.
- `*://*.eth.limo/*`, `*://*.eth.link/*` — same mechanism for the optional mirror-hostname interception.

**Optional host permissions** (`https://*/*`, `http://*/*`):

These are **not** granted at install time. They are requested dynamically via `chrome.permissions.request` in a user-gesture path _only_ when the user adds or changes their primary execution RPC endpoint in the options page (so the extension can `fetch()` that specific RPC origin). The extension does not broadly access arbitrary sites; the optional grant is scoped to whatever RPC origin the user has chosen.

---

### 7. Remote Code

**Justification:**

The extension does NOT use remote code execution. All JavaScript and WebAssembly is bundled at build time and included in the extension package. Helios (the Ethereum light client) ships as a bundled `.wasm` blob; `'wasm-unsafe-eval'` in the extension CSP is required solely to instantiate this local WASM module.

The extension makes network requests to:

1. The user's own locally-running **Kubo IPFS node** (`127.0.0.1:5001` / `*.ipfs.localhost:8080`) to serve resolved content.
2. The user-configured **Ethereum execution RPC** to perform `eth_call`s for ENS resolution. This endpoint is entirely user-controlled.
3. The user-configured **Ethereum consensus RPC** (default: a public Helios-compatible beacon-chain endpoint, overridable) to bootstrap and sync the light client.

None of these requests involve downloading or executing code. They are purely data-fetching operations using standard `fetch` / HTTP requests.

---

## Privacy Policy URL

https://github.com/apoorvlathey/dapp3/blob/main/PRIVACY_POLICY.md

---

## Content Scripts Justification

The extension injects a single content script (`src/content/banner.ts`) scoped to `http://*.ipfs.localhost/*` and `http://*.ipns.localhost/*` — i.e. only on pages served by the user's own local Kubo gateway. It does **not** run on `<all_urls>`.

Its sole purpose is to render a small trust banner on gateway pages. The banner:

1. Reads the original ENS name / path from `chrome.storage.session` (keyed by `tabId`, written by the service worker at redirect time).
2. Displays the ENS name, the resolved CID, a link to view the ENS history, a bookmark-toggle star, and a "hide for this session" dismiss control.
3. Tracks SPA navigations within the gateway page so the banner stays accurate.

The content script does not read page content, DOM beyond its own injected element, or any user data on the gateway page.

---

## Web Accessible Resources

The extension exposes the following HTML pages as web-accessible resources so they can be loaded as top-level navigation targets from the service worker:

- `error.html` — extension-internal error page shown when resolution or the gateway fails, in place of Chrome's DNS-failure UI.
- `interstitial.html` — cold-start "waiting for Helios to sync" page shown while the light client finishes bootstrapping.
- `offscreen.html` — the offscreen document hosting Helios.
- `onboarding.html` — the 4-step first-run wizard.
- `bookmarks.html` — the user's bookmarks page.

None of these expose sensitive capabilities to arbitrary sites; they are plain extension UI pages.

---

## Additional Notes for Review

1. **Open Source:** The extension source code is available at the repository linked in the extension listing.

2. **No Monetization:** The extension does not contain ads, in-app purchases, or any form of monetization.

3. **Trust model:** The entire point of the extension is to _remove_ trusted intermediaries from the ENS-to-content path. ENS resolution is performed by a local Helios light client that verifies execution-layer state against a synced consensus header; content is served from the user's own Kubo node. No public gateway (e.g. `eth.limo`, `ipfs.io`) is ever trusted on the hot path.

4. **Mainnet-only, first-level `.eth` only:** The extension intentionally scopes its interception to `<name>.eth` on Ethereum mainnet. Subdomains and non-mainnet ENS deployments are out of scope.

5. **Chromium 116+ / MV3 only:** `minimum_chrome_version` is set to 116 because the `chrome.offscreen` API (required for Helios) is not available on earlier versions.
