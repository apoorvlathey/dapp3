# dapp3 — ERC-4804 Fallback PRD

Companion to [PRD.md](./PRD.md). Scoped to the ERC-4804 ("web3://") fallback resolution path. Implementation details live in [IMPLEMENTATION.md](./IMPLEMENTATION.md) once the feature ships.

## 1. Background & Motivation

The v1 extension resolves `*.eth` to an IPFS contenthash and serves the content from the user's local Kubo node. Many ENS names do not set an IPFS contenthash. A growing class of dapps (zRouter, zSwap, vitalikblog, art-blocks, …) instead live entirely on Ethereum: the contract at the ENS-resolved address stores HTML and exposes it via [ERC-4804](https://eips.ethereum.org/EIPS/eip-4804) / [ERC-5219](https://eips.ethereum.org/EIPS/eip-5219). Without 4804 support, `zrouter.eth` resolves but renders nothing.

We want to extend the existing resolver: if the ENS name has no IPFS contenthash but the resolved address is a contract that implements ERC-4804, serve the onchain HTML through the same `<cid>.ipfs.localhost:8080` gateway we already use for IPFS dapps. The trick is content-addressing: we fetch the HTML via Helios-verified `eth_call`, pin the bytes to local Kubo, and redirect the tab to the resulting CID. The user gets a proper isolated origin per dapp (wallet injection, partitioned localStorage, normal browser primitives), and the trust model stays end-to-end local-first.

Two prior-art reference points:
- **chrome-web3** (`github.com/ComfyGummy/chrome-web3`) intercepts navigations via DNR and serves HTML from a SW `fetch` listener at `chrome-extension://<id>/...`. It works for content dapps but explicitly cannot inject `window.ethereum` (kills wallet-class dapps like zSwap) and shares one origin across every web3:// site. Our Kubo-pinning approach avoids both limitations.
- **w3link.io / w3eth.io** are public HTTP gateways for web3:// URLs. Trusted third party. Same shape of compromise we are replacing for the IPFS path.

## 2. Goals

- A `*.eth` navigation whose resolved address is a contract implementing ERC-4804 (manual / 5219 mode) renders correctly in a tab, served from `<cid>.ipfs.localhost:8080`.
- The HTML body is fetched via Helios-verified `eth_call`. Kubo serves it locally. No external gateway in the path.
- Repeat loads of the same dapp are perceived as instant (sub-50 ms to first paint), backed by a content-addressed cache plus stale-while-revalidate.
- Per-dapp origin isolation matches the IPFS path: cookies, localStorage, service-worker scope, and wallet injection all behave as on a normal website.
- Storage growth on the user's Kubo node is bounded and auditable.

## 3. Non-Goals (v1 of this feature)

- **Auto-mode `resolveMode`.** Many older web3:// sites (vitalikblog historically) parse the URL path into calldata. Auto mode has its own elaborate rules (`?returns=` decoding, type inference, etc.) and is deferred. v1 handles only contracts where `resolveMode()` returns `"5219"` or `"manual"`.
- **Path / query routing.** v1 only serves the index, i.e. `request([], [])`. Multi-resource ERC-5219 sites (`/post/123`, `/render/78/0`) are deferred. Single-page dapps that route client-side in JS are unaffected.
- **Non-HTML response bodies.** v1 expects `Content-Type: text/html` (or no header). Images, JSON, CSS responses returned by a 5219 contract are deferred.
- **Honoring contract-returned headers.** Kubo's gateway sets its own response headers. We ignore the `KeyValue[] headers` tuple from `request()` in v1; revisit only if a real dapp depends on it.
- **Status codes other than 200.** 3xx redirects, 4xx errors, etc. surface as the extension's error page in v1.
- **Chains other than mainnet.** Same scope as the rest of the extension.
- **Non-ENS triggers.** Direct navigation to `*.w3eth.io` / `*.w3link.io` style gateway URLs is out of scope; we resolve `.eth` only.

## 4. User Flow

### 4.1 One-time Kubo CORS setup

Kubo's RPC API on `:5001` rejects browser-originated requests whose `Origin` header isn't on its allowlist (CSRF / DNS-rebinding defense). Pinning ERC-4804 bodies requires `POST /api/v0/add`, so the user has to allow the extension origin once. The extension owns this step end-to-end:

1. On first navigation that needs the API (first ERC-4804 site, or earlier via the onboarding probe), the extension `POST`s a tiny canary body. If Kubo returns 403 (Origin not allowed), the extension surfaces a setup screen instead of the error page.
2. The setup screen shows the user's actual extension ID (`chrome.runtime.id`) and the exact `ipfs config` commands prefilled, with a "copy" button per command. It links to the equivalent IPFS Desktop UI flow for users who don't have the CLI on PATH.
3. A "Recheck" button re-probes the canary. On 200, the extension closes the setup screen and resumes the original navigation; the user never has to retype the URL.
4. If onboarding is run later (existing wizard), the API probe runs there too so users who reinstall don't rediscover this through a failed dapp load.

This mirrors how IPFS Companion handles the same Origin restriction. It is one-time per Kubo install and the extension ID is stable for both unpacked and Web Store installs, so the user does it exactly once.

### 4.2 Normal use

1. User types `zrouter.eth` (or any ENS name with no IPFS contenthash) in the address bar.
2. Extension intercepts the navigation, runs the existing ENS resolution, finds no IPFS contenthash.
3. Extension reads the resolver's `addr()` and probes the contract via Helios:
   - `eth_getCode` confirms it is a contract.
   - `eth_call resolveMode()` returns `"5219"` or `"manual"`.
   - `eth_call request([], [])` returns `(200, "<!doctype html>...", headers)`.
4. The HTML body is sha256-fingerprinted. If we have seen this exact body before for this contract, we reuse the previously computed CID and skip Kubo. Otherwise we pin to Kubo and store the new CID.
5. Tab is redirected to `http://<cid>.ipfs.localhost:8080/`.
6. The existing banner content script renders the original ENS name on top of the page, same as the IPFS path.
7. On the next visit to the same dapp, the redirect happens immediately from cache; a background revalidation eth_call confirms the bytes are still current and updates the cache transparently if not.

If any step fails (EOA at the resolved address, `resolveMode()` is auto / unknown, `request()` reverts, status non-200, body too large, body not HTML, Kubo unreachable), the existing extension error page surfaces with a specific reason.

## 5. Architecture

### 5.1 Resolution path

The resolver in `src/lib/resolver.ts` already returns `{ kind: "ipfs" | "ipns", value }` after decoding the contenthash. It will gain a third return shape `{ kind: "web3", cid }`, produced by a new module `src/lib/web3url.ts` that runs only when the contenthash branch returns nothing.

All onchain reads (`addr()`, `eth_getCode`, `resolveMode()`, `request()`) go through the existing Helios EIP-1193 provider — same trust model as the contenthash read.

### 5.2 Content addressing & cache

State in `chrome.storage.local` under a new key `web3UrlCache`:

```
{ [contractAddress]: { contentHash, cid, bodyLen, lastAccess } }
```

Per resolution:

1. `body = eth_call request([], [])`
2. `h = sha256(body)` via `crypto.subtle.digest`
3. If `cache[contract].contentHash === h`, reuse `cache[contract].cid`. Skip Kubo.
4. Else `POST /api/v0/add?pin=true&cid-version=1&raw-leaves=true&to-files=/dapp3/web3/<contract>/<h>` to Kubo. Update cache with returned CID.
5. Redirect to `http://<cid>.ipfs.localhost:8080/`.

Kubo's `add` is idempotent — re-adding identical bytes is a no-op. The local sha256 is purely an optimization to skip the Kubo round-trip when content is unchanged. Computing the IPFS CID locally (e.g. via a bundled UnixFS encoder) is possible but not worth the bundle weight in v1; deferred.

### 5.3 Stale-while-revalidate

To make repeat loads perceived as instant:

1. On navigation, look up `cache[contract]`. If present, redirect synchronously. First paint is sub-50 ms.
2. After the redirect, kick off the eth_call asynchronously. Compute sha256 on the response.
   - Match → bump `lastAccess`, done.
   - Mismatch → re-pin, update cache. The next navigation picks up the new CID.

For zSwap-class non-upgradeable dapps the bytes never change and revalidation is a permanent no-op. For upgradeable contracts the user sees one navigation of staleness on a redeploy. A "new version available — refresh" content-script banner is on the v2 list.

Revalidation may be rate-limited per contract (e.g. once per N minutes) to keep Helios load light on heavy users.

### 5.4 Storage growth

Pins live under a dedicated MFS path so we can enumerate and prune:

```
/dapp3/web3/<contractAddress>/<contentHash>
```

A budget (default: 50 MB or 200 entries, configurable in options) bounds total storage. On exceeding the budget after a new pin, evict the LRU entry: `files rm` the MFS path, unpin, drop the cache entry. The options page exposes the list of pinned web3 dapps with size and last-access timestamp; the user can manually evict any entry.

### 5.5 Origin behavior

The serving origin is `http://<cid>.ipfs.localhost:8080`, identical in shape to the IPFS path. Two consequences worth noting in the PRD:

- Two ENS names that resolve to the same contract produce the same CID and therefore share an origin. This is correct: same content is the same identity.
- The serving origin is a function of the onchain HTML, not the ENS name. If the same dapp is reachable through multiple ENS names, they share localStorage. If a dapp redeploys with new bytes, it gets a new origin and loses its prior storage. This matches IPFS-path behavior.

## 6. UX & Error Surfaces

### 6.1 Setup screen (Kubo CORS)

A new extension page `src/setup-kubo/setup-kubo.html` is shown whenever the API probe returns 403. Contents:

- One-line explanation of why Kubo is rejecting the extension.
- The two `ipfs config` commands prefilled with `chrome.runtime.id`, each with a "Copy" button.
- A short "or in IPFS Desktop UI" walkthrough for users without the `ipfs` CLI on PATH.
- A "Recheck" button that re-probes the API and either resumes the original navigation (the queued `?return=` URL) or stays on the setup screen with the latest error.
- A "Skip ERC-4804 support" link that records the user's choice and routes the original navigation to the standard error page (`web3-pin-failed`) without nagging again until they retry from the error page.

### 6.2 Onboarding integration

The existing onboarding wizard (`src/onboarding/`) currently probes only the gateway on `:8080`. A new sub-step inside the IPFS step probes the API and, on 403, shows the same setup-kubo content inline before letting the user proceed. The probe is silent on success.

### 6.3 Error page variants

The extension's existing error page (`src/error/error.html`) gains new variants. Each surfaces the underlying reason without throwing into Chrome's DNS-failure UI:

- `web3-not-a-contract` — resolved address is an EOA.
- `web3-unsupported-mode` — `resolveMode()` returned something other than `"5219"` / `"manual"` (auto mode is v2).
- `web3-call-reverted` — `request()` reverted; contract is not ERC-4804-compatible.
- `web3-bad-status` — non-200 status code returned.
- `web3-non-html` — body is not HTML and v1 cannot serve it.
- `web3-body-too-large` — body exceeds the size cap (see §7).
- `web3-pin-failed` — Kubo unreachable or `add` failed for reasons other than CORS (CORS routes to the setup screen instead).

The options page gains a "Web3:// dapps" section listing pinned entries with controls to evict and a numeric budget setting.

## 7. Constraints & Limits

- **Body size cap.** ERC-5219 does not bound response size. We enforce a 1 MB hard cap. A malicious or buggy contract returning more should error cleanly, not exhaust SW memory or balloon Kubo. Configurable in options for power users.
- **Index-only routing.** v1 always calls `request([], [])`. Path-bearing navigations (e.g. `zrouter.eth/foo/bar`) collapse to the index in v1; the dapp's own client-side router takes over after first paint.
- **Helios warm path required.** Cold-start Helios sync is the dominant first-load latency. The existing interstitial covers this. Subsequent first-loads of new dapps are bounded by one eth_call plus one Kubo `add`.
- **Trust scope is unchanged.** The HTML body is bytes returned from `eth_call` against state proven by Helios against the consensus-committed root. Kubo is a content-addressed local serving layer; it cannot lie about content because the URL embeds the CID.

## 8. Milestones

- **W1.** Resolver fallback: `web3url.ts` module, `resolveMode()` + `request()` decoding via Helios, basic eth_call → Kubo `add` → redirect, no cache. Wire into `resolver.ts`. Error-page variants for the §6.3 cases. End-to-end flow on `zrouter.eth`.
- **W1.5.** Kubo CORS setup UX: classify 403 vs other Kubo failures in `kubo.ts`, build the `setup-kubo.html` page (prefilled commands + recheck + skip), wire CORS detection in the SW to redirect to setup with a `return=` param, integrate the same probe into the onboarding wizard's IPFS step.
- **W2.** Cache + stale-while-revalidate: chrome.storage cache keyed by contract, sha256 fingerprint, synchronous redirect on cache hit, async revalidation. Body-size cap enforced.
- **W3.** Storage management: MFS path layout, LRU eviction on budget exceed, options-page listing + manual eviction.
- **W4.** Polish & telemetry: revalidation rate limit, settings (size cap, entry budget), README mention, manual QA against a small zoo of known web3:// contracts.

## 9. Open Questions

- **Auto-mode coverage in a follow-up.** Skipping auto mode in v1 cuts a chunk of the existing ecosystem (vitalikblog, art-blocks). Worth doing W5 right after W4, or batching with multi-resource path support?
- **Body-size cap default.** 1 MB is a guess. Should we be more generous given Kubo handles big files fine, or stricter to keep Helios eth_call latency predictable?
- **Revalidation policy.** Always-on every navigation, or rate-limited? An immutable-by-default hint (contract has no admin / proxy markers) would let us skip revalidation entirely for zSwap-class dapps, but detecting that is non-trivial.
- **`content://` style paths in the URL bar.** Users typing `zrouter.eth/foo` today: collapse to index (v1 plan), or queue path-routing for v2?
- **CSP & sandboxing.** Kubo's gateway returns a permissive CSP by default. The same risk applies as for IPFS dapps today — content can do whatever HTML/JS does. Worth a separate review pass once a few real web3:// dapps are running.

## 10. Progress Log

- **2026-05-06 — W1 + W1.5 shipped.** ERC-4804 fallback resolves end-to-end: `src/lib/web3url.ts` (resolveMode + request decoding via Helios), `src/lib/kubo.ts` (multipart `add` + 403/405 → CORS classification), wired into `resolver.ts` after the contenthash branch fails. CORS rejection no longer surfaces as a per-site error; the interstitial renders an inline setup card with prefilled `ipfs config` commands and a Recheck button, preserving the address-bar context. Onboarding wizard probes `/api/v0/version` and shows the same setup affordance silently on success.
- **2026-05-06 — W2 shipped.** sha256 fingerprint of the response body via `crypto.subtle.digest`; a per-contract cache (`src/lib/web3url-cache.ts`) lets us skip the Kubo `add` round-trip when bytes are unchanged. The ENS-keyed cache (`src/lib/cache.ts`) now stores web3 entries too, so first paint on repeat visits is a synchronous redirect off the cached CID. `refreshFromCache` re-resolves in the background and pushes `content-updated` to the banner on mismatch; per-contract rate limit (`web3RevalidateMinIntervalMs`, default 30s) avoids hammering Helios on multi-page dapps.
- **2026-05-06 — W3 shipped.** MFS path layout `/dapp3/web3/<contract>/<contentHash>` (passed via `to-files`). LRU eviction kicks in on insert when either `web3SizeCapBytes` (default 50 MB) or `web3EntryBudget` (default 200) would be exceeded — eviction runs `pin/rm` and `files/rm` then drops the cache entry. Options page gained a "Web3:// dapps (ERC-4804)" section listing pinned entries with size, last-access, and a per-entry evict button; numeric inputs for the two budgets.
- **2026-05-06 — W4 shipped.** Settings (size cap, entry budget, revalidation interval) plumbed through `src/lib/settings.ts`. README and IMPLEMENTATION.md updated. Manual smoke test against `zrouter.eth`: cold load pins, warm load skips `add` and redirects synchronously.
