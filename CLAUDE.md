# local-eth-limo

Local-first, trust-minimized browser extension that resolves `*.eth` navigations directly against Ethereum state (via a Helios light client running in an offscreen document) and serves the contenthash from the user's own Kubo IPFS node. Replacement for the hijacked `eth.limo` public gateway.

Chromium MV3 only. Mainnet only. First-level `.eth` names only. See `PRD.md` for full scope and non-goals.

## Tooling

- Package manager: **pnpm** (there's a `pnpm-lock.yaml` — don't use npm/yarn).
- Build: `pnpm build` (runs `tsc --noEmit` + `vite build`). Dev: `pnpm dev` (HMR, but SW changes still need extension reload).
- Typecheck only: `pnpm typecheck`.
- Load the built extension from `dist/` as unpacked in `chrome://extensions`.
- TypeScript strict mode. Path alias `@/*` → `src/*`.

## Top-level layout

```
manifest.config.ts     # @crxjs manifest (permissions, CSP, host perms, DNR rules)
vite.config.ts         # build config — has a load-bearing `modulePreload: false`
PRD.md                 # scope, architecture, progress log (read for "why")
IMPLEMENTATION.md      # landmines, runtime model, Helios gotchas (read for "how")
public/rules/          # static declarativeNetRequest rules (HTTPS-upgrade bypass)
src/
  background/          # MV3 service worker — entry point for navigation interception
  offscreen/           # chrome.offscreen page hosting Helios WASM
  content/             # injected banner on *.ipfs.localhost / *.ipns.localhost
  popup/               # toolbar popup (status dashboard)
  options/             # full settings page (RPC list, stats, Helios status)
  onboarding/          # 4-step first-run wizard
  interstitial/        # cold-start "waiting for Helios" page
  error/               # extension-internal error page (replaces Chrome's DNS error)
  lib/
    resolver.ts        # ENS → contenthash → {kind, value} core logic
    helios-client.ts   # SW-side bridge to the offscreen doc
    helios-bridge.ts   # message type definitions shared by SW and offscreen
    gateway.ts         # CIDv1/IPNS → subdomain URL builder
    settings.ts        # typed chrome.storage.local wrapper + change observer
    rpc-stats.ts       # per-URL success/failure/latency persistence
    messaging.ts       # TabContext + ResolveResponse types
    sw-dom-shim.ts     # window/document polyfill for SW context (load-bearing!)
```

The big things the layout hides:

- **The SW cannot run Helios** — WASM sync state wouldn't survive the SW's ~30s idle death. Everything Helios-related lives in the offscreen doc (`src/offscreen/offscreen.ts`), and the SW talks to it via `chrome.runtime.sendMessage` with `target: "offscreen"`.
- **The resolver runs in the SW**, not the offscreen. Viem's `PublicClient` is created with `custom(heliosEip1193Provider())` — the provider's `request()` bridges across to the offscreen. Every `eth_call` is a message round-trip.

## Conventions that matter

- **Log prefix: `[local-eth-limo]`.** Grep for it when debugging a live session.
- Errors surfaced to the user go through the extension's own error page (`src/error/error.html`), not thrown into Chrome's DNS-failure UI.
- All settings reads/writes go through `src/lib/settings.ts` — don't touch `chrome.storage.local` directly. The module's `onSettingsChanged` is load-bearing: the SW uses it to detect primary-RPC changes and reboot Helios.
- **When the primary RPC changes** (`rpcUrls[0]`), the SW tears down Helios and reboots it. Helios takes one execution RPC at boot; swapping is not hot-reload.
- Defaults for the consensus RPC live as a `DEFAULT_CONSENSUS_RPC` constant duplicated in four files (`offscreen.ts`, `helios-client.ts`, `onboarding.ts`, `options.ts`). If you change one, change all four. (There is a real reason it's not centralized — see IMPLEMENTATION.md § "Bundles don't cross SW/offscreen/page boundaries".)

## Deeper dive

For the non-obvious stuff — why `modulePreload: false` is load-bearing, why every `await import()` that might happen inside viem explodes in the SW, what endpoints Helios hits on the consensus RPC and what happens when each one fails, the full message-type map across SW/offscreen/page, and the list of landmines we've hit and fixed — see **[IMPLEMENTATION.md](./IMPLEMENTATION.md)**.

For product scope, milestone status, and the running progress log, see **[PRD.md](./PRD.md)**.
