# Implementation notes

Companion to `CLAUDE.md`. This file is the accumulated "why things are the way they are" — landmines, runtime constraints, and design decisions that aren't self-evident from reading the source. Skim the table of contents; dive in when a symptom matches.

## Contents

1. [Runtime topology](#1-runtime-topology)
2. [Navigation flow (end-to-end)](#2-navigation-flow-end-to-end)
3. [The Helios bridge](#3-the-helios-bridge)
4. [MV3 service worker landmines](#4-mv3-service-worker-landmines)
5. [Consensus RPC selection](#5-consensus-rpc-selection)
6. [ENS resolution gotchas](#6-ens-resolution-gotchas)
7. [Kubo / IPFS integration](#7-kubo--ipfs-integration)
8. [Permissions model](#8-permissions-model)
9. [Build pipeline](#9-build-pipeline)
10. [Known incidents and fixes](#10-known-incidents-and-fixes)

---

## 1. Runtime topology

Three distinct JS contexts, each with different globals and lifetimes:

| Context | File(s) | Lifetime | Has DOM? | Can run WASM? |
|---|---|---|---|---|
| Service worker | `src/background/service-worker.ts` | Ephemeral (~30s idle → terminated, revived on event) | ❌ (no `window`, no `document`) | ✅ but no sync `import()` |
| Offscreen document | `src/offscreen/offscreen.ts` | Lives as long as SW references it | ✅ full DOM | ✅ |
| Extension pages (popup, options, onboarding, interstitial, error) | `src/*/…ts` | Per-tab | ✅ full DOM | ✅ |
| Content script | `src/content/banner.ts` | Per-host-page | ✅ page DOM (isolated world) | ✅ |

Communication is exclusively via `chrome.runtime.sendMessage`. There is **no shared module state** across contexts — each is a separate bundle. Hot cache in the offscreen doc (the `HeliosProvider` instance, `localStorage` for checkpoint cache) does **not** migrate to the SW.

The offscreen doc's existence is managed by `ensureOffscreen()` in `src/lib/helios-client.ts`. It's idempotent; the SW calls it on every offscreen message. First call creates the doc with reasons `[LOCAL_STORAGE, WORKERS]` — both are needed (LOCAL_STORAGE for Helios's checkpoint cache, WORKERS for the WASM).

## 2. Navigation flow (end-to-end)

Tracing `vitalik.eth` from URL bar to rendered page:

1. User types `vitalik.eth`. Chrome issues a top-level navigation.
2. `chrome.webNavigation.onBeforeNavigate` fires in the SW. We filter on `frameId === 0` and hostname matching `/^[a-z0-9-]+\.eth\.?$/i`.
3. SW checks settings. If no RPC configured → redirect to `error.html` with an explanation.
4. SW calls `getOrStartHelios()` (fire-and-forget; idempotent). Then `await getHeliosStatus()`.
5. **If synced**: `resolveEns(name)` runs in the SW. It:
   - Creates a viem `PublicClient` with `custom(heliosEip1193Provider())` transport.
   - `client.getEnsResolver({ name })` → resolver address.
   - `client.readContract({ ..., functionName: "contenthash" })` → raw bytes.
   - Decode via `@ensdomains/content-hash` → `{ kind: "ipfs" | "ipns", value }`.
   - Every RPC-facing call is a message round-trip to the offscreen doc.
6. **If not synced**: redirect to `interstitial.html`, which polls `get-helios-status` at 750ms. When `synced`, it sends `interstitial-retry` → SW runs `resolveAndRedirect`.
7. SW writes `TabContext` into `chrome.storage.session` under `tab:<tabId>`, then `chrome.tabs.update(tabId, { url: gatewayUrl })`.
8. Kubo serves content at `http://<cid>.ipfs.localhost:8080/`.
9. Content script (`banner.ts`) loads at `document_start` on `*.ipfs.localhost` / `*.ipns.localhost`, fetches `get-tab-ctx`, injects a closed shadow-DOM banner.
10. SPA navigations inside the loaded page → banner updates via `pushState`/`replaceState`/`popstate`/`hashchange` hooks.

## 3. The Helios bridge

The core abstraction: `heliosEip1193Provider()` in `src/lib/helios-client.ts` returns a viem-compatible `{ request }` shape. Each call sends `{ target: "offscreen", type: "helios-request", method, params }` to the offscreen doc, which forwards to `provider.request({ method, params })` inside the real `HeliosProvider` instance.

**The offscreen state machine:**

```
idle → booting → syncing → synced
                         ↘ error
```

- `idle`: no provider, no boot in flight.
- `booting`: `createHeliosProvider` is in progress (WASM init, fresh checkpoint fetch, bootstrap).
- `syncing`: provider exists, `waitSynced()` is running.
- `synced`: ready to serve requests.
- `error`: last boot failed; next bootstrap call will try again.

`handleRequest()` rejects anything that isn't `synced`. Callers must gate on `getHeliosStatus()` before dispatching reads.

**What Helios itself does to the consensus RPC at runtime:**

- **Bootstrap** (once): `GET /eth/v1/beacon/light_client/bootstrap/<root>`. Needs an epoch-boundary finalized block root. We fetch one via `/eth/v1/beacon/headers/finalized` (preferred) or `/eth/v1/beacon/states/head/finality_checkpoints` (fallback) — see `fetchFreshCheckpoint` in `src/offscreen/offscreen.ts`.
- **Sync updates**: `GET /eth/v1/beacon/light_client/updates?start_period=…&count=…`. Sync-committee rotation.
- **Advance loop** (every ~12s, forever): `GET /eth/v2/beacon/blocks/<slot>` to pull the execution payload. **This is the endpoint that keeps eth_calls working.** If the consensus RPC rate-limits it (429) or doesn't serve it, `waitSynced()` still returns but the freshness timestamp stays at 0 and every `eth_call` fails with `"out of sync: <unix now> seconds behind"`.

This last point is the single most important thing to know: **sync != working**. If you see `out of sync: N seconds behind` where N is close to the current Unix epoch, the consensus RPC's blocks endpoint is the culprit, not the execution RPC.

## 4. MV3 service worker landmines

### 4.1 `document is not defined` from inside viem

Viem's `call.js` catch block does `await import('../utils/ccip.js')` for every failed `eth_call` (to attempt CCIP-read resolution). Vite compiles that into a `__vitePreload` helper call. `__vitePreload` does two DOM things:

1. Injects `<link rel="modulepreload">` into `document.head` to warm the HTTP cache.
2. Dispatches a `"vite:preloadError"` event on `window` if the import rejects.

Neither `document` nor `window` exist in the SW. The symptom is that Helios-side ENS resolution fails with `"document is not defined"` — **completely unrelated to the real error** (which might be `"out of sync: ..."` or similar).

**Two-part fix:**

1. `vite.config.ts` sets `modulePreload: false` — disables the `<link rel=modulepreload>` injection path.
2. `src/lib/sw-dom-shim.ts` stubs `window.dispatchEvent` + `document.{getElementsByTagName, querySelector, head, createElement}` as no-ops. Imported at the top of `src/background/service-worker.ts`.

After both fixes, a failed `import()` in the SW throws the *actual* reason instead of masking it.

### 4.2 `import() is disallowed on ServiceWorkerGlobalScope`

HTML spec forbids dynamic `import()` inside a `ServiceWorkerGlobalScope` ([w3c/ServiceWorker#1356](https://github.com/w3c/ServiceWorker/issues/1356)). Chrome enforces it. Viem's CCIP-read fallback path (`await import('ccip.js')`) triggers this on *every* failed eth_call in the SW.

We can't fix viem from the outside, so we work around it by making sure the original Helios error surfaces *before* viem's catch block has a chance to explode. `heliosEip1193Provider.request()` in `src/lib/helios-client.ts` wraps its body with a `try/catch` that `console.error`s the raw reason so debugging isn't blocked.

If in the future we need CCIP-read (currently a §3 non-goal), this has to be solved properly — either by preloading the ccip module so dynamic `import()` is never needed, or by moving all viem calls into the offscreen doc.

### 4.3 The SW can die between `ensureHeliosBooted()` and `heliosRequest()`

Not currently a problem in practice — the offscreen doc survives SW restarts as long as Chrome hasn't garbage-collected it. But if you see mysterious "Helios not initialized" errors after a long idle, this is the suspect. The v1 deferred mitigation is a keep-alive port; not implemented.

## 5. Consensus RPC selection

The default consensus RPC is **`https://ethereum-beacon-api.publicnode.com`**. This was picked after several failures of alternatives:

| Endpoint | Problem |
|---|---|
| Helios's baked-in `0x65a7ed…` checkpoint | Too old; no public RPC still serves `light_client/bootstrap/<root>` for it. We fetch a fresh root instead. |
| `lodestar-mainnet.chainsafe.io` | Honors `?count=N` on `/updates` (good) but **rate-limits `/eth/v2/beacon/blocks/<slot>` with 429s** (fatal — see §3 advance loop). |
| `ethereum.operationsolarstorm.org` | `GET /headers/finalized` → 301 to plain HTTP URL. HTTPS host permission doesn't cover the redirect target. 8s fetch timeout. |
| `www.lightclientdata.org` | Returns **503 on every endpoint** (not just state API — even `/eth/v1/beacon/light_client/*` which is its supposed reason for existence). Currently down. |
| `beaconstate.info`, `beaconstate-mainnet.chainsafe.io` | Serve `/states/*` but 404 on `/headers/finalized` and `/light_client/bootstrap/<root>`. |
| **`ethereum-beacon-api.publicnode.com`** | ✅ 200 on all four endpoints we need. `count` handling is slightly loose (returns 2 or 3 regardless) but passes enough updates that Helios syncs fine. **Current default.** |
| `eth-beacon-chain.drpc.org` | ✅ Also works end-to-end. Honors `count` strictly. Viable alternative; exposed as a chip in onboarding. |

If you're asked to change the default: verify all five endpoints respond 200 from curl *and* that `/eth/v2/beacon/blocks/<most-recent-finalized-slot>` returns a payload (not 429, not 404). A single run of `fetchFreshCheckpoint` is not sufficient — Helios's *sync* can succeed while the *advance loop* is broken, and you'll only notice when every `eth_call` starts failing with "out of sync".

The four files with the `DEFAULT_CONSENSUS_RPC` constant are a known wart. They're not centralized in a shared module because:
- `offscreen.ts` and `helios-client.ts` run in different bundles (different Rollup entry points). A shared import creates a duplicated chunk per bundle anyway.
- `onboarding.ts` and `options.ts` are separate HTML entry bundles.

Changing the default touches all four. Don't forget the one in `fetchFreshCheckpoint`'s comment/error-message text.

## 6. ENS resolution gotchas

- **Codec allowlist.** `@ensdomains/content-hash` can decode many codecs. We only accept `ipfs` and `ipns`; everything else is rejected with a user-visible error. This is enforced in `src/lib/resolver.ts`.
- **Empty contenthash.** `0x` is a valid contract return meaning "not set". Surfaced as "`<name>` has no contenthash set."
- **Namehash vs. resolver lookup.** `client.getEnsResolver({ name })` walks up the parent chain internally to find the resolver. We then call `contenthash(namehash(name))` against *that* resolver, with the namehash computed for the *full* name.
- **CCIP-read (ERC-3668).** Not supported. `getEnsResolver` for a CCIP-gated name (e.g. `cb.id`) will fail. See §3 non-goal in PRD.
- **First-level only.** Regex `/^[a-z0-9-]+\.eth$/`. `sub.name.eth` is rejected.
- **Lowercase normalization.** The regex is lower-only; we `.toLowerCase()` before matching. Mixed-case input is normalized.
- **Viem's CCIP fallback path is what causes the SW landmines in §4.** Any failed `eth_call` — including ones that have nothing to do with CCIP — triggers the `await import('ccip.js')` branch. That's why `contenthash() reverted` on a name with no contenthash used to surface as `document is not defined`.

## 7. Kubo / IPFS integration

- **Port 5001 (the Kubo RPC API) is not used**, except briefly during earlier onboarding probes. Kubo's RPC rejects browser requests whose `Origin` isn't on its allowlist (CSRF defense), so we'd need to prompt users to edit their Kubo config. The content gateway on 8080 is all we need.
- **Liveness probe**: `fetch("http://bafkqaaa.ipfs.localhost:8080/", { mode: "no-cors", signal: AbortSignal.timeout(2500) })`. `bafkqaaa` is the empty-UnixFS CID. A resolved promise (even with an opaque response) proves that (a) Kubo is up on 8080, and (b) subdomain routing is enabled. Both are the hard requirements.
- **Subdomain gateway requires CIDv1 base32 lowercase.** `@ensdomains/content-hash` emits in this form already for IPFS; we don't convert. If we ever encounter CIDv0 from a contenthash, `multiformats` is imported for the fallback (not currently triggered in practice).
- **IPNS label encoding.** DNS-safe: `.` → `-`, `-` → `--`. Labels >63 chars are invalid. ENS labels never hit 63 chars so this is a theoretical concern only.
- **HTTPS upgrade.** Chrome's "Always use secure connections" would redirect `http://*.ipfs.localhost` to HTTPS, which Kubo doesn't serve. Bypassed via a static `declarativeNetRequest` allow-rule at `public/rules/no_https_upgrade.json`.
- **IPNS trust gap.** ENS → IPNS-key mapping is verified by Helios. IPNS-key → CID resolution happens inside Kubo and is *not* verified by us. Documented as a known v1 limitation.
- **Do not use Kubo's DNSLink path** (`http://vitalik-eth.ipns.localhost:8080`). It's known-broken for `.eth` ([kubo#10639](https://github.com/ipfs/kubo/issues/10639)) and would bypass Helios entirely.
- **ERC-4804 path uses the Kubo RPC API.** Unlike the IPFS contenthash path, the ERC-4804 fallback (PRD_ERC4804.md) needs to *write* content to Kubo via `POST /api/v0/add`. This requires the user to allow the extension's origin in `API.HTTPHeaders.Access-Control-Allow-Origin` once. The extension probes `/api/v0/version` first; on 403/405 the interstitial renders an inline setup card with prefilled `ipfs config` commands instead of routing to the error page. The probe and the actual add helper share the CORS-classification path in `src/lib/kubo.ts`.
- **Two web3 caches**, intentionally separate. `src/lib/cache.ts` is keyed by ENS name and gives a synchronous redirect target on repeat visits (sub-50 ms first paint). `src/lib/web3url-cache.ts` is keyed by contract address and stores the sha256 of the onchain HTML body plus the resulting CID — its job is to skip the Kubo `add` round-trip when the body bytes haven't changed. Both are populated on a successful Helios-verified resolve.
- **Why sha256 and not the IPFS CID?** Computing a CIDv1 locally would require bundling a UnixFS encoder, which more than doubles the SW chunk. We sidestep that by hashing the raw bytes ourselves (`crypto.subtle.digest`) and trusting Kubo to be content-addressed: re-adding identical bytes is idempotent, but skipping the round-trip on a hash match is the win we actually want.
- **MFS layout for evictability**: pinned web3 bodies live at `/dapp3/web3/<contract>/<contentHash>`. Eviction issues `pin/rm` on the CID and `files/rm --recursive --force` on the path. The recursive form lets us tolerate Kubo's internal layout choices (file vs. directory), and `force` makes a missing path a no-op. We accept best-effort failure here: a stuck pin only leaks Kubo storage, not extension state.
- **Stale-while-revalidate**, in `src/background/service-worker.ts`. On a cache hit the interstitial is told to redirect immediately; the SW kicks off `refreshFromCache` which re-runs `resolveEns`. For web3 entries a per-contract rate limit (`web3RevalidateMinIntervalMs`, default 30s) skips the eth_call when we've already revalidated recently — a multi-page web3 dapp clicking around its own routes triggers many same-contract resolves, and we don't want to hammer Helios. On content change the cache is updated and `content-updated` is pushed to the banner.

## 8. Permissions model

- **Static host permissions** (granted at install): `http://127.0.0.1/*`, `http://localhost/*`, `http://*.localhost/*`. Covers Kubo and the gateway subdomains.
- **Optional host permissions**: `https://*/*` + `http://*/*`. Must be explicitly requested via `chrome.permissions.request` in a user-gesture path. We prompt on:
  - Onboarding step 2 submit — execution RPC + default consensus RPC in one prompt.
  - Onboarding step 3 submit — consensus RPC override (if different from default).
  - Options page "Add RPC" submit.
- **`chrome.permissions.request` from the SW**: unreliable across Chrome versions because it's not a user-gesture context. `ensureHostPermission` in `src/lib/helios-client.ts` first checks `contains()` and only requests if missing. In the happy path (user granted during onboarding), this is a no-op.
- **Other perms**: `webNavigation` (required to intercept `.eth`), `tabs` (for `tabs.update` redirect), `storage` (settings + session state), `offscreen` (Helios host), `declarativeNetRequest` (HTTPS-upgrade bypass rule).

## 9. Build pipeline

- `@crxjs/vite-plugin` generates the MV3 manifest from `manifest.config.ts` and handles entry points for `background`, `content_scripts`, and `web_accessible_resources`.
- **Extra HTML entry points** (`error`, `interstitial`, `offscreen`, `onboarding`) are listed in `rollupOptions.input`. Without this, their `<script>` refs wouldn't be rewritten to hashed asset paths.
- **`modulePreload: false`** — see §4.1.
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. The `wasm-unsafe-eval` directive allows Helios's WASM to instantiate. If it ever fails on an older `wasm-bindgen` output, relax to `unsafe-eval` — but the current version compiles fine with the narrow permission.
- **Offscreen chunk is ~4.2 MB raw / 1.6 MB gzipped.** The size is dominated by inlined Helios WASM (base64'd into the JS). One-time cost per offscreen doc lifetime; fine for v1.

## 10. Known incidents and fixes

Chronological log of real failures encountered and how they were solved. Useful for pattern-matching similar future incidents.

### "document is not defined" on ENS resolution
- **Symptom**: ENS resolution worked against a direct RPC but failed under Helios with `ReferenceError: document is not defined`.
- **Root cause**: Viem's `call.js` catch block does `await import('ccip.js')`; Vite's `__vitePreload` helper accesses `document.head` to inject a preload link. The error is triggered by the preload helper, not the actual Helios error.
- **Fix**: `modulePreload: false` in `vite.config.ts`. See §4.1.

### "window is not defined"
- **Symptom**: After fixing "document" error, got `ReferenceError: window is not defined`.
- **Root cause**: Even with `modulePreload: false`, viem still reaches a path that does `window.dispatchEvent(new Event('vite:preloadError'))` on import rejection.
- **Fix**: `src/lib/sw-dom-shim.ts`. See §4.1.

### "import() is disallowed on ServiceWorkerGlobalScope"
- **Symptom**: After DOM-shim, got the real error. MV3 forbids dynamic `import()` in SW.
- **Root cause**: HTML spec (w3c/ServiceWorker#1356).
- **Fix**: Log raw errors from `heliosEip1193Provider.request()` so they surface before viem's catch path triggers the disallowed `import()`. See §4.2.

### "out of sync: <huge number> seconds behind"
- **Symptom**: `waitSynced()` returned but every `eth_call` failed. The number in the error was ~= current Unix time, meaning the freshness-gate was reading 0.
- **Root cause**: `lodestar-mainnet.chainsafe.io` rate-limits `/eth/v2/beacon/blocks/<slot>` with 429. Helios's advance loop can't fetch execution payloads. Identified from DevTools Network panel.
- **Fix**: Switched consensus RPC default. See §5.

### 503 on `fetchFreshCheckpoint` after switching to lightclientdata.org
- **Symptom**: Bootstrap never started; every endpoint returned 503.
- **Root cause**: `www.lightclientdata.org` is currently down at the origin level. Not a REST surface issue.
- **Fix**: Switched default to `ethereum-beacon-api.publicnode.com`. Kept the `tryFinalityCheckpoints` → `tryHeaders` fallback chain in `fetchFreshCheckpoint` for future compatibility with light-client-only nodes. See §5.

### Onboarding probed Kubo on port 5001 and got 403
- **Symptom**: First-run test showed "IPFS not reachable" even though IPFS Desktop was running.
- **Root cause**: Kubo's RPC API (port 5001) rejects browser `Origin` requests as a CSRF defense. The extension never actually needs 5001.
- **Fix**: Switched probe to `fetch("http://bafkqaaa.ipfs.localhost:8080/", { mode: "no-cors" })`. See §7.

### Stale localStorage checkpoint causing silent "out of sync" loop
- **Symptom**: Even after passing a fresh checkpoint, Helios's internal state reflected an older one.
- **Root cause**: Helios with `dbType: "localstorage"` reads any cached checkpoint and prefers it over the passed-in value.
- **Fix**: `localStorage.clear()` before `createHeliosProvider` in `src/offscreen/offscreen.ts`. Defensive; belt-and-suspenders.
