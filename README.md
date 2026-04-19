# dapp3

A local-first, trust-minimized browser extension that resolves `*.eth` navigations directly against Ethereum state (via a Helios light client) and serves the contenthash from the user's own Kubo IPFS node.

See [PRD.md](./PRD.md) for full scope, architecture, and milestones.

## Prerequisites

- Node 20+
- [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) (or any Kubo) running locally, exposing the subdomain gateway at `http://localhost:8080` and the RPC at `http://127.0.0.1:5001`.
- Chromium 116+ (Chrome / Brave / Arc / Edge).

## Development

```sh
pnpm install
pnpm dev
```

Then load `dist/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).

`pnpm dev` keeps HMR running for options / popup / content pages. Reload the extension after changes to the background service worker.

## Current status

See [§ Milestones](./PRD.md#9-milestones) in the PRD and the **Progress Log** at the end of it for what's actually been built.
