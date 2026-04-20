# dapp3 — Product Requirements Document

## 1. Background & Motivation

`eth.limo` is (was) the de-facto public gateway for resolving ENS names to their IPFS-hosted content. A user typing `vitalik.eth` in a browser relied on `eth.limo`'s DNS + gateway infrastructure to look up the ENS `contenthash`, fetch the content from IPFS, and serve it back as a normal webpage.

The public `.eth.limo` DNS was hijacked, breaking the trust model of a centralized gateway sitting between users and the decentralized web it was meant to expose. A local-first, trust-minimized replacement is needed — one that a user runs on their own device, resolves ENS directly from Ethereum state, and fetches IPFS content from a local IPFS node. No central gateway, no shared DNS, no TLS cert middleman.

## 2. Goals

- A browser extension that lets users type `vitalik.eth` and see the correct ENS-hosted content rendered in a normal browser tab.
- ENS resolution happens through a trust-minimized light client (Helios), verified against the Ethereum consensus-committed state root.
- IPFS content is served from the user's own local Kubo node (IPFS Desktop), with per-CID origin isolation via Kubo's subdomain gateway.
- The user's real intent (`vitalik.eth`) is preserved visually via a persistent, extension-injected banner — even though the actual URL in the address bar points to `127.0.0.1`.

## 3. Non-Goals (v1)

- No support for CCIP-read / offchain resolvers (ERC-3668). Names like `cb.id` that depend on offchain gateways are out of scope. To be revisited.
- No public IPFS gateway fallback. Users must run IPFS Desktop (or a Kubo node) locally. This is a deliberate choice to keep the trust model end-to-end local-first.
- No Firefox / Safari port in v1. Chromium (MV3) only.
- No support for chains other than Ethereum mainnet.

## 4. User Flow

1. **One-time install & onboarding.** User installs the extension. Onboarding checks:
   - Is Kubo reachable at `http://127.0.0.1:8080` and its RPC at `http://127.0.0.1:5001`? If not, link to IPFS Desktop install instructions and block further setup until detected.
   - Collect one or more Ethereum execution RPC URLs from the user. The extension explains that Helios will verify state reads against these — they don't need to be trusted.
   - Fetch a fresh weak-subjectivity checkpoint and bootstrap Helios. Show a sync progress UI.

2. **Normal use.** User types `vitalik.eth` in the address bar.
   - Extension intercepts the navigation before the browser issues DNS.
   - Resolves the ENS `contenthash` via Helios-verified `eth_call` against the resolver contract.
   - Decodes the contenthash to a CIDv1 base32 (for IPFS) or IPNS key (for IPNS).
   - Redirects the tab to `http://<cid>.ipfs.localhost:8080/` (or `http://<label>.ipns.localhost:8080/`).
   - Kubo serves the content. The CID-per-subdomain form isolates each ENS site under its own browser origin (cookies, localStorage, service-worker scope).

3. **Banner & in-site navigation.** A content script injects a shadow-DOM banner at the top of every `*.ipfs.localhost` / `*.ipns.localhost` page. The banner shows:
   - The original ENS name (`vitalik.eth`) + current path.
   - Helios sync/online status.
   - A link to the full underlying `http://<cid>.ipfs.localhost:8080/...` URL for transparency.
   - The banner updates on SPA client-side navigations (`pushState`/`replaceState`/`popstate`).

## 5. Architecture

### 5.1 Components

| Component | Responsibility | Runtime |
|---|---|---|
| **Service Worker (background)** | `webNavigation` listener, tab redirect, message routing between content script and offscreen doc, RPC health tracking, settings storage. | MV3 SW (ephemeral — dies after ~30s idle) |
| **Offscreen Document** | Hosts Helios light client (long-lived). Exposes resolve-ENS RPC to the SW via `chrome.runtime.sendMessage`. | `chrome.offscreen` page, kept alive by SW |
| **Content Script** | Injects the ENS banner on `*.ipfs.localhost` / `*.ipns.localhost` pages. Tracks SPA navigations. Reads the original ENS name from `chrome.storage.session` (keyed by tabId). | Page context |
| **Options / Popup UI** | Onboarding, RPC list management, IPFS node status, Helios sync status, manual "trust RPC directly" override toggle. | Extension page |

### 5.2 ENS Resolution Path

1. `chrome.webNavigation.onBeforeNavigate` fires on `*.eth`.
2. SW sends `{ type: 'resolve', name }` to offscreen doc.
3. Offscreen doc calls `viem.publicClient.getEnsResolver(name)`, then reads `contenthash(namehash)` via the Helios EIP-1193 provider (`createPublicClient({ transport: custom(helios) })`).
4. Decode with `@ensdomains/content-hash`. For IPFS, convert to CIDv1 base32 lowercase. For IPNS, keep the key as-is.
5. SW writes `{ tabId: { ensName, path, cid } }` into `chrome.storage.session`, then `chrome.tabs.update(tabId, { url: redirectTarget })`.

### 5.3 Helios Configuration

- Package: `@a16z/helios` (EIP-1193 provider, not a local HTTP RPC — no extra daemon needed).
- Runs inside the offscreen document (SW would terminate it).
- **Checkpoint sync:** use Helios's standard default checkpoint source (`sync-mainnet.beaconcha.in`) on first run. Expose the checkpoint source in advanced settings for users who want to change it.
- **Consensus RPC:** use Helios's standard default (`https://www.lightclientdata.org`). Exposed in advanced settings.
- **Execution RPC:** user-supplied list (see §5.4).
- `network: 'mainnet'`.
- On cold start, the first `.eth` navigation waits on `helios.waitSynced()`. Show a "resolving…" interstitial page. If sync exceeds a threshold, surface the "skip Helios and trust RPC directly (temporary)" option.

### 5.4 RPC Selection & Health Tracking

User provides **one or more** Ethereum mainnet execution RPC URLs during onboarding. The extension chooses which to use per-request via:

- **Local health stats**, persisted in `chrome.storage.local`. Per-URL counters: success count, failure count, last-failure timestamp, rolling latency (p50, p95).
- **Selection policy (v1):** weighted round-robin biased toward the RPC with the best recent success rate. Demote any RPC with a recent failure for a cooldown period (e.g. 60s); promote back on successful probe.
- **Failure modes tracked:** HTTP error, JSON-RPC error, proof-verification failure in Helios, timeout.
- **User visibility:** options page shows a live table of each RPC's current stats and lets the user reorder, disable, or remove entries.

### 5.5 Manifest V3 Specifics

- `webNavigation.onBeforeNavigate` for async ENS resolution + `chrome.tabs.update` redirect. (`declarativeNetRequest` rules are synchronous and cannot wait on an RPC; not viable here.)
- `chrome.offscreen` page to host Helios (avoids SW termination killing sync state).
- `host_permissions`: `http://127.0.0.1/*`, `http://localhost/*`, plus the user's RPC origins (requested dynamically or via `optional_host_permissions`).
- `declarativeNetRequest` **is** used for one narrow purpose: a static allow-rule preventing Chrome's "Always use secure connections" setting from HTTPS-upgrading `http://*.ipfs.localhost` and `http://*.ipns.localhost`. Without this, the upgrade breaks the redirect.
- Content script matched on `http://*.ipfs.localhost/*` and `http://*.ipns.localhost/*`.

## 6. UI / Status Surfaces

### 6.1 Extension Popup

Minimal dashboard:
- IPFS node: Online / Offline (Kubo health check).
- Helios: Syncing X% / Online / Offline.
- Quick toggle: "Bypass Helios (trust RPC directly)" — off by default, auto-reverts when Helios is next ready unless user pins it.
- Link to full options page.

### 6.2 Injected Banner (on resolved pages)

Shadow-DOM banner pinned to top:
- `vitalik.eth/current/path` — displayed as the canonical identity of the page.
- Helios status icon (green = verified, amber = syncing, red = bypassed/RPC-trusted).
- Small "…" menu: copy underlying gateway URL, disable banner for this origin, open extension settings.
- Updates reactively on SPA navigations via monkey-patched `history.pushState` / `replaceState` + `popstate` listener.

### 6.3 Cold-Start Interstitial

When a `.eth` navigation fires and Helios isn't yet synced, the tab is redirected to an extension-owned page showing:
- Sync progress bar.
- "Waiting for Helios to sync…" explanation.
- Button: **"Resolve now via RPC (skip Helios this time)"** — user opts in to trusting the RPC directly for this one resolution. Logged and reflected in the banner of the resulting page.

### 6.4 Options Page

- IPFS node settings (URL, health).
- Ethereum RPC list (add/remove/reorder, live stats, probe now).
- Helios advanced settings (consensus RPC URL, checkpoint source) — prefilled with defaults, editable.
- Debug / logs view.

## 7. Technical Notes & Gotchas

- **CID form requirement.** Kubo's subdomain gateway requires CIDv1 base32 lowercase. Always convert before building the redirect URL.
- **IPNS label encoding.** DNS-safe: `.` → `-`, `-` → `--`. Labels >63 chars are rejected by Kubo (not a concern for ENS names, but relevant if we ever surface raw IPNS keys).
- **IPNS trust gap (v1 known limitation).** For IPNS contenthashes, the record resolution happens inside Kubo, not inside Helios. We verify the ENS→IPNS-key mapping, but not the IPNS-key→CID mapping. Documented; acceptable for v1.
- **HTTPS upgrade.** Chrome's default-HTTPS setting will break `http://*.ipfs.localhost` without the DNR allow-rule. Covered in §5.5.
- **Checkpoint staleness.** Helios requires a weak-subjectivity checkpoint <2 weeks old. Startup fetches a fresh one from the configured source.
- **Kubo's own DNSLink path (`http://vitalik-eth.ipns.localhost:8080`) is not used.** It's known to be broken for `.eth` ([kubo#10639](https://github.com/ipfs/kubo/issues/10639)) and it would bypass Helios verification entirely. We resolve ENS ourselves, always.
- **Banner CSP.** Some ENS sites ship strict CSP. Shadow DOM isolates styles but a hostile / broken CSP could still block the banner's script injection. Content scripts run in an isolated world, so this should not be blocked in practice — to verify during implementation.
- **Tab-ID ↔ ENS-name mapping** lives in `chrome.storage.session` (cleared on browser restart — correct behavior). On banner content-script init, read the entry and hydrate.

## 8. Dependencies

- `@a16z/helios` — light client (WASM + EIP-1193 provider).
- `viem` — ENS helpers, `publicClient`, `custom()` transport for Helios provider.
- `@ensdomains/content-hash` — decode ENS `contenthash` bytes.
- `multiformats` — CIDv0 → CIDv1 base32 conversion if needed.
- Build tooling: Vite + a Chrome-extension plugin (e.g. `@crxjs/vite-plugin`) for HMR during development.

## 9. Milestones

1. **M1 — Skeleton extension.** ✅ *done* — MV3 manifest, SW, content script stub, options page scaffolding. Hard-coded redirect from `*.eth` to `http://<hard-coded-cid>.ipfs.localhost:8080/`.
2. **M2 — Real ENS resolution via user-supplied RPC (no Helios yet).** ✅ *done* — viem + content-hash decoding. Banner injection.
3. **M3 — Helios in offscreen doc.** ✅ *done (pending manual browser verification)* — Replace direct RPC with Helios-verified reads. Sync status surface. Cold-start interstitial.
4. **M4 — RPC health tracking & multi-RPC selection.** ✅ *done* — Options page table, stats persistence. v1 uses a single "primary" RPC (first in list) for Helios; manual reorder reboots Helios. Automatic weighted-failover is deferred (see progress log).
5. **M5 — Onboarding polish.** ✅ *done* — IPFS Desktop detection, RPC collection UI, checkpoint bootstrap.
6. **M6 — Beta release.** Chrome Web Store listing (or sideload guide).

## 10. Open Questions

- Publish to Chrome Web Store immediately, or start with unpacked-load + signed release on GitHub? (Web Store review may balk at WASM + local-network permissions without a clear justification doc.)
- Telemetry: opt-in error reporting for Helios sync failures / RPC failures / resolution failures? Strict zero-telemetry by default fits the trust model best.
- CCIP-read support post-v1: whitelist gateway list, or require user consent per-domain?

## 11. Progress Log

> Running log of what has actually been built, versus §9 which is the forward-looking plan. Updated as work lands.

### 2026-04-19 — M1 skeleton landed

- Vite + `@crxjs/vite-plugin` + TypeScript (strict) project scaffolded. `pnpm build` and `pnpm typecheck` are green.
- MV3 manifest (`manifest.config.ts`) declares: service worker, content script scoped to `http://*.ipfs.localhost/*` + `http://*.ipns.localhost/*`, popup, options page, `declarativeNetRequest` static rule resource, permissions (`webNavigation`, `tabs`, `storage`, `offscreen`, `declarativeNetRequest`), host permissions for localhost + 127.0.0.1.
- Static DNR rule (`public/rules/no_https_upgrade.json`) issues `allow` for every resource type on `*.ipfs.localhost` + `*.ipns.localhost` so Chrome's HTTPS-upgrade setting cannot break the redirect. Covers §5.5.
- Background SW (`src/background/service-worker.ts`) hooks `webNavigation.onBeforeNavigate`, filters top-level `*.eth` navigations, calls the resolver, writes `{ensName, kind, value, path}` into `chrome.storage.session` keyed by `tab:<tabId>`, then `chrome.tabs.update` to the gateway URL. Cleans up session storage on tab close. Responds to `get-tab-ctx` messages from the content script.
- Resolver (`src/lib/resolver.ts`) is a stub that always returns a fixed CIDv1 for any `*.eth`. M2 will swap this for viem + `@ensdomains/content-hash` against a user-supplied RPC.
- Gateway URL builder (`src/lib/gateway.ts`) handles CIDv1 base32 + IPNS-label DNS encoding (`.` → `-`, `-` → `--`).
- Content script (`src/content/banner.ts`) renders a closed-shadow-DOM banner at `document_start`, offsets `body` margin-top, and re-renders on `pushState` / `replaceState` / `popstate` / `hashchange`. Hydrates via `chrome.runtime.sendMessage({type:"get-tab-ctx"})`.
- Popup (`src/popup/`) shows Kubo reachability by probing `POST http://127.0.0.1:5001/api/v0/version`. Helios status is still a placeholder.
- Options page (`src/options/`) has an RPC add/remove list persisted via a typed settings module (`src/lib/settings.ts`, `chrome.storage.local`). No health tracking yet — that's M4.
- `web_accessible_resources` for the offscreen doc + interstitial deferred to the milestone that introduces those files (M3), to keep the build unblocked.

### 2026-04-19 — M2 landed

- `resolveEns` now does real work: reads the first RPC URL from settings, spins up a memoized viem `publicClient` with `http()` transport on mainnet, calls `client.getEnsResolver({ name })`, then `readContract` for `contenthash(namehash(name))` against the resolver ABI. Empty contenthash (`0x`) is an explicit error.
- `@ensdomains/content-hash`'s `getCodec` + `decode` produce `{ kind: 'ipfs' | 'ipns', value }`. IPFS values come back as CIDv1 base32 already (no manual conversion needed). Unknown codecs are rejected — v1 is IPFS / IPNS only.
- New extension-internal error page at `src/error/error.html` (`chrome-extension://<id>/src/error/error.html?name=…&error=…`). The SW redirects failed `.eth` navigations here instead of letting Chrome's DNS error show. Declared in `web_accessible_resources`.
- Options page now calls `chrome.permissions.request({ origins: [<rpc-origin>/*] })` at the time an RPC is added. `optional_host_permissions` is set to `http://*/*` + `https://*/*` so the dynamic grant works without the user re-installing.
- viem lands at ~263 KB raw / 82 KB gzipped in the SW bundle — fine as a one-shot init cost.

**Known gaps going into M3:**
- ENS names that resolve via CCIP-read will fail at `getEnsResolver` / `contenthash` because viem doesn't auto-follow ERC-3668 without wiring `ccipRead`. Matches the §3 non-goal.
- Currently always uses `rpcUrls[0]`. Multi-RPC selection is M4.
- Banner shows a static amber dot — no Helios sync state to reflect yet.

### 2026-04-19 — M3 landed (code complete; needs manual browser verification)

- `@a16z/helios` runs in `chrome.offscreen` doc (`src/offscreen/offscreen.ts`). The doc is lazily created on first demand via `chrome.offscreen.createDocument({ reasons: [LOCAL_STORAGE, WORKERS] })`. Justification is documented inline.
- Offscreen holds the `HeliosProvider` plus a small state machine (`idle` → `booting` → `syncing` → `synced` / `error`). Responds to four message types: `helios-bootstrap`, `helios-status`, `helios-request`, `helios-shutdown`. All discriminated by `target: "offscreen"` so popup / options listeners don't pick them up.
- SW-side bridge (`src/lib/helios-client.ts`) owns offscreen lifecycle (`ensureOffscreen` memo), exposes `ensureHeliosBooted`, `getHeliosStatus`, `heliosRequest`, and `heliosEip1193Provider()` — the last one returns an EIP-1193-shaped `{ request }` that viem's `custom()` transport consumes. Resolver now uses `custom(heliosEip1193Provider())` instead of `http()`.
- Cold-start interstitial at `src/interstitial/interstitial.html` polls `get-helios-status` on a 750ms cadence. When status flips to `synced`, it sends `interstitial-retry` back to the SW which performs `resolveAndRedirect`. Also has a **"Resolve via RPC (skip Helios this time)"** bypass button that sets `bypassHelios: true`, forcing the resolver onto a direct `http()` transport for just that call. The resulting `TabContext.trustedDirectly` flag flows through to the banner which shows a red dot in that case.
- Popup polls Helios status once per second and renders `idle`/`booting`/`syncing`/`synced`/`error`.
- CSP tightened: `"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` so Helios's WASM `instantiate` is allowed.
- Host permissions: execution RPC origin is requested from the options page on RPC add (user gesture). The default consensus RPC (`https://www.lightclientdata.org`) is requested in the same prompt. Pre-existing grants short-circuit the request.
- Vite config: HTML files under `web_accessible_resources` (`error`, `interstitial`, `offscreen`) were not being processed as entry points; added to `rollupOptions.input` so their `<script>` / `<link>` refs get rewritten to built asset paths.
- Helios bundle is ~4.2 MB raw / 1.6 MB gzipped (WASM is base64-inlined into the offscreen chunk). One-time load per offscreen doc lifetime. Acceptable for v1.

**Known gaps / things to confirm with a real browser:**
- WASM `'wasm-unsafe-eval'` vs. `'unsafe-eval'`: some older `wasm-bindgen` outputs require the latter. If the offscreen doc's console shows a CSP error on `new WebAssembly.Module`, relax to `'unsafe-eval'`. `wasm-unsafe-eval` is the correct narrow permission for modern `wasm-bindgen` so we're trying that first.
- Offscreen doc lifetime: Chrome keeps it alive as long as the SW is alive and/or messages are flowing. If Helios sync state is lost after SW restart + offscreen GC, users will see another sync. We'll need to measure this in practice before deciding whether to add a keep-alive port.
- `chrome.permissions.request` from a non-user-gesture path (the SW) isn't reliably supported across Chrome versions. The options-page gesture is the primary flow; the SW fallback (`ensureHostPermission`) only runs if `contains()` says we already have it, so it should be a no-op in the happy path.
- CCIP-read names will still fail (per §3 non-goal) — Helios doesn't auto-follow ERC-3668, so the resolver read just errors.

### 2026-04-19 — M4 landed

**Design decision (revises §5.4):** Helios takes a single `executionRpc` at boot and swapping it costs a full re-sync. For v1 we do not do automatic weighted round-robin; instead we treat "the RPC pool" as an **ordered preference list**. The primary (index 0) is what Helios uses; subordinates are tracked/probed but unused until promoted manually. Automatic demote-on-failure + Helios reboot is deferred to post-v1 when we can do it without hurting sync latency.

- `src/lib/rpc-stats.ts` persists a `StatsMap` under `chrome.storage.local:rpcStats` keyed by URL: `success`, `failure`, `lastSuccessAt`, `lastFailureAt`, `lastFailureReason`, `lastFailureKind`, and a ring buffer of the last 20 latencies. `classifyError()` buckets thrown errors into `http | jsonrpc | timeout | helios-verify | other`.
- `resolveEns` wraps its RPC-facing calls (`getEnsResolver`, `readContract`) with timing + success/failure reporting against the URL that was used. Decode failures count as RPC-success (the RPC worked; the failure is local).
- New `probeRpc(url)` function does a cheap `getBlockNumber()` + records stats; the SW exposes it via a `probe-rpc` message. The options UI's "⟲ Probe now" button uses it.
- Options page now shows a live table: rank (primary vs. #N), URL, success, failure, success rate (color-coded), avg latency, last-failure line with age + kind + reason. Reorder up/down, probe, remove. Uses `onSettingsChanged` + `onStatsChanged` for live updates — no polling.
- Primary-change detection in the SW: when `rpcUrls[0]` changes (reorder, add-to-empty, or primary removal), it calls `shutdownHelios()` and kicks `getOrStartHelios()` to reboot against the new primary.
- Removing a URL also clears its stats so the table stays consistent.

**Deferred to post-v1:**
- Weighted round-robin across multiple RPCs per §5.4. Needs either (a) Helios support for a `executionRpc` list, or (b) a viem `fallback()` transport for the direct-bypass path only (Helios stays pinned to primary). (b) is the likely shape.
- Latency percentiles (p50/p95). Current avg-of-last-20 is adequate for the table UI.
- Per-URL disable toggle. For now users remove + re-add.

### 2026-04-19 — M5 landed

- Four-step onboarding wizard at `src/onboarding/onboarding.html`:
  1. **IPFS** — probes `POST http://127.0.0.1:5001/api/v0/version`. "Next" is gated on a successful probe; shows install link + troubleshooting tips on failure.
  2. **RPC** — user enters a mainnet execution RPC URL. Submit fires `chrome.permissions.request` for both the RPC origin and the default consensus RPC origin in one prompt (user gesture path). On success, saves the URL as the primary (prepends to the existing list, so the wizard can be re-run without losing other RPCs).
  3. **Advanced (optional)** — consensus RPC override + checkpoint hash (regex-validated as 0x-prefixed 32-byte hex). Changing the consensus RPC triggers an additional permission request.
  4. **Sync** — polls Helios status, shows `booting → syncing → synced`. "Finish setup" button enables once synced; writes `onboardingComplete: true` and redirects to the options page.
- `chrome.runtime.onInstalled` with `reason === "install"` opens the onboarding page in a new tab on fresh install. Not on update/reload.
- Options page now redirects to onboarding if `!onboardingComplete && rpcUrls.length === 0` — covers the case where a user opens settings before finishing the wizard.
- Popup's "Open settings" button routes to onboarding instead of options if onboarding is incomplete.
- `Settings` gained `consensusRpc`, `checkpoint`, and `onboardingComplete` fields. Helios bootstrap already reads `consensusRpc` from settings; `checkpoint` is now wired through to the offscreen bootstrap config path.
- Checkpoint bootstrap: the PRD originally called for the extension to force-fetch a fresh checkpoint. In practice Helios's own `dbType: "localstorage"` bootstrap handles this on cold start using its internal default source, and the user can paste a fresher hash from `sync-mainnet.beaconcha.in` in the advanced step if the default looks stale. Explicit in-extension checkpoint fetching (against a configurable source) is documented as post-v1.

### 2026-04-19 — field-testing fixes

During first unpacked-load test, two real issues surfaced that only show up in a running browser:

1. **Kubo RPC probe got a 403.** The onboarding was probing `POST http://127.0.0.1:5001/api/v0/version`. Kubo rejects browser-originated API requests whose `Origin` isn't on its allowlist — a CSRF / DNS-rebinding defense. The extension never actually *uses* port 5001; the content gateway on 8080 is what matters. Switched the probe to `fetch('http://bafkqaaa.ipfs.localhost:8080/', { mode: 'no-cors' })` — the empty-UnixFS CID against the subdomain gateway. A resolved promise proves the gateway is reachable AND subdomains are enabled (the two things we actually need).

2. **Helios bootstrap 503 was a stale default checkpoint, not a network problem.** Helios has a baked-in mainnet checkpoint `0x65a7ed542f…` that no public consensus RPC still serves light-client bootstrap data for. `lightclientdata.org` returns 503 for it (likely overloaded from users hitting that one old checkpoint); other beacon APIs that support `/eth/v1/beacon/light_client/*` at all return 404. Fix: before `createHeliosProvider`, the offscreen doc now calls `GET <consensusRpc>/eth/v1/beacon/headers/finalized` and passes the returned block root through as the `checkpoint` config field. Auto-fetched per cold start; user can still override in advanced settings.

3. **Default consensus RPC had to change twice.** First tried `ethereum.operationsolarstorm.org` — returns 200 by curl but silently 301s to `http://testing.mainnet.beacon-api.nimbus.team` (plain HTTP). The extension has only the HTTPS origin as a host permission, so the browser stalls on the redirect and the 8s fetch times out. Re-scanned public beacon APIs with a *fresh* finalized root (previous scan used a zero root and incorrectly flagged working hosts as 404):
   - `https://ethereum-beacon-api.publicnode.com` → **200 HTTPS end-to-end**, serves `/headers/finalized` and `/light_client/bootstrap/<root>` cleanly. New default.
   - `https://www.lightclientdata.org` → still 503.
   - `https://beaconstate.ethstaker.cc`, `stakely.io`, `beaconstate.info`, `sync-mainnet.beaconcha.in`, `checkpointz.pietjepuk.net`, `ethereum-mainnet-cl.publicnode.com` → 404 on light-client endpoints.
   - `ethereum.operationsolarstorm.org` → 200 only after following the HTTP redirect.

   Checkpoint-fetch timeout bumped 8s → 15s for first-cold-start margin.

### All planned milestones delivered

M1–M5 are landed. `pnpm build` and `pnpm typecheck` are both clean. Final bundle: offscreen chunk ~4.2 MB (1.6 MB gzipped) with inlined Helios WASM, everything else small.

**Outstanding for M6 (beta release) — not yet started:**
- Load-unpacked walkthrough in the README.
- Real browser verification of the full flow: install → onboarding → type `vitalik.eth` → see banner + content. This has been *built* end-to-end but not yet *run* in Chrome.
- Chrome Web Store listing: justification docs for WASM, local-network host permissions, `webNavigation`; privacy disclosure; icon set.
- Decide: publish to store immediately vs. GitHub-only signed release first (Open Question §10).

**Post-v1 backlog (captured here so nothing gets lost):**
- Weighted round-robin across multiple RPCs with Helios reboot on demote (see M4 design note).
- Latency p50/p95 (currently rolling avg of last 20).
- Per-RPC disable toggle without removal.
- In-extension checkpoint fetching against a configurable source (`sync-mainnet.beaconcha.in` default).
- Offscreen keep-alive port to survive SW restarts without losing sync state.
- CCIP-read (ERC-3668) support — likely gated on Helios exposing `ccipRead` hooks.
- Telemetry (opt-in) for sync/resolution failure rates.
- Firefox / Safari ports.
