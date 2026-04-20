# Privacy Policy

**Last Updated:** April 21, 2026

dapp3.eth ("the Extension") is a Chrome browser extension that resolves `*.eth` ENS names locally and serves their content from the user's own IPFS node. This Privacy Policy explains how the Extension handles your information.

---

## Data Collection

### Data Stored Locally on Your Device

The Extension stores the following data locally in your browser using Chrome's storage APIs:

- **User Settings**: The primary Ethereum execution RPC URL, the consensus (beacon-chain) RPC URL, the optional checkpoint hash used to bootstrap the Helios light client, and feature toggles (e.g. whether to intercept `*.eth.limo` / `*.eth.link` mirror hostnames).
- **Bookmarks**: URLs you have starred from the in-page banner.
- **ENS Resolution Cache**: Recent `name → contenthash` lookups, kept so repeat navigations are instant. Refreshed in the background.
- **Per-Tab Navigation Context**: The original ENS name and path for each intercepted tab, so the gateway-page banner can display them. Stored in `chrome.storage.session` and cleared when the browser restarts.
- **Onboarding Completion Flag**: So the first-run wizard is not shown again.

**Important**: All of this data remains on your device. The Extension has no servers and collects nothing from you.

---

## Data Transmission

The Extension transmits data to the following endpoints, all of which are either local to your machine or user-configured:

| Service                            | Data Sent                                            | Purpose                                                                                               |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Your local Kubo IPFS node**      | CIDs / IPNS names (over `127.0.0.1` / `*.localhost`) | Serve the resolved content from the node running on your own device                                   |
| **Your Ethereum execution RPC**    | Standard `eth_call` / `eth_getProof` requests        | Resolve ENS names against Ethereum mainnet state via the Helios light client (endpoint is your choice) |
| **Your Ethereum consensus RPC**    | Standard beacon-chain API requests                   | Bootstrap and keep the Helios light client synced (endpoint is your choice; a default is provided)    |

No data is sent to the Extension developer or to any first-party dapp3.eth server — there is no such server.

---

## Data We Do NOT Collect

- Browsing history or visits to sites outside the `*.eth` / local-gateway scope
- Personal information (name, email, wallet addresses, etc.)
- Analytics or usage tracking
- Keystrokes or form inputs
- Any data from pages you visit

---

## Data Retention

- **Local Data**: Stored until you clear it via the Extension options page or uninstall the Extension.
- **Session Data**: Per-tab navigation context is cleared automatically when the browser restarts.
- **No Server Storage**: No servers are operated for this Extension; no data ever leaves your device except to the local and user-configured endpoints listed above.

---

## Data Deletion

You can delete your data at any time:

1. **Reset Settings**: Use the options page to reset RPC endpoints, clear bookmarks, and clear the ENS resolution cache.
2. **Uninstall**: Uninstall the Extension to remove all stored data.
3. **Browser Data**: Clear the Extension's storage from Chrome's `chrome://extensions` settings.

---

## Third-Party Services

The Extension itself has no backend. However, by configuring the Extension you choose third-party endpoints that it communicates with on your behalf:

- **Ethereum execution RPC**: Whatever provider you configure (e.g. your own node, or a public RPC). Subject to that provider's own terms and privacy policy.
- **Ethereum consensus RPC**: Same as above; a default is provided but can be overridden.
- **Ethereum mainnet**: Queries are made to read chain state. This is a public blockchain; the operator of the RPC endpoint you choose can observe your queries.

The Extension does not route traffic through any public ENS or IPFS gateway (e.g. `eth.limo`, `ipfs.io`) by default. Its entire purpose is to remove that trusted third party from the path.

---

## Security

- The Extension runs a light client (Helios) that cryptographically verifies Ethereum execution-layer state against a synced consensus header. It does not trust RPC responses blindly.
- All code and WebAssembly is bundled at build time; no remote code is fetched or executed at runtime.
- Content is served from your own locally-running Kubo IPFS node, not a public gateway.

---

## Children's Privacy

The Extension is not intended for use by children under 13 years of age. No information is knowingly collected from children.

---

## Changes to This Policy

This Privacy Policy may be updated from time to time. Changes will be reflected in the "Last Updated" date at the top of this document.

---

## Contact

If you have questions about this Privacy Policy, you can reach out via:

- Twitter/X: [@apoorveth](https://x.com/apoorveth)
- GitHub: Open an issue in the repository

---

## Open Source

dapp3.eth is open source. You can review the code to verify these privacy practices.
