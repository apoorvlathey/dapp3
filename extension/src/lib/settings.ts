export type Settings = {
  rpcUrl?: string;
  consensusRpc?: string;
  // Optional list of additional beacon endpoints that must byte-equal agree
  // with the primary `consensusRpc` on the finalized block root before Helios
  // bootstraps. Defeats single-operator compromise of the bootstrap trust
  // anchor: an attacker would have to control every configured beacon to
  // forge it. Empty/undefined → today's behavior (single-source bootstrap).
  // The user grants host permission per-entry when adding via the options
  // page; the settings module just stores the URLs.
  consensusVerifiers?: string[];
  checkpoint?: string;
  onboardingComplete?: boolean;
  // Intercept `*.eth.limo` and `*.eth.link` navigations and route them through
  // local resolution (Helios + Kubo) instead of the public gateways. Default
  // true; gets forced false at onboarding if Kubo isn't reachable, since
  // intercepting without a working IPFS node would just break those links for
  // the user. Name is historical — it governs both eth.limo and eth.link.
  interceptEthLimo: boolean;
  // Intercept ERC-4804 hosted gateway navigations (`0x<addr>.w3eth.io` and
  // `0x<addr>.1.w3link.io`) and route the contract address through local
  // ERC-4804 resolution. Same default-true / Kubo-gated story as
  // interceptEthLimo. The gateway host carries the contract address directly,
  // so the resolver skips ENS lookup and goes straight to the ERC-4804 fetch
  // path.
  interceptW3Eth: boolean;
  // Local Kubo subdomain gateway used to serve resolved IPFS/IPNS/ERC-4804
  // content. Defaults to Kubo's standard localhost:8080 gateway, but users
  // can point routing at another subdomain-capable gateway host.
  ipfsGatewayHost: string;
  ipfsGatewayPort: number;
  // Intercept `*.gwei.domains` navigations (the public Gwei Name Service
  // gateway) and route them through local resolution (Helios + Kubo) instead.
  // The DNR rule rewrites `<label>.gwei.domains` → `<label>.gwei`, which the
  // .gwei redirect rule then catches. Same default-true / Kubo-gated story as
  // interceptEthLimo.
  interceptGweiDomains: boolean;
  // ERC-4804 cache budgets. See PRD_ERC4804.md §5.4 / §7 / W4. Both bound
  // total Kubo storage used by web3:// dapps; LRU eviction kicks in when
  // either is exceeded. Defaults are exported from web3url-cache.ts.
  web3SizeCapBytes?: number;
  web3EntryBudget?: number;
  // Minimum interval (ms) between background revalidations of the same
  // ERC-4804 contract. Keeps Helios load light on heavy users by skipping
  // the eth_call when a recent revalidation has already happened. See PRD §5.3.
  web3RevalidateMinIntervalMs?: number;
  // Optional: after a normal ENS IPFS contenthash resolve, ask the local Kubo
  // API to recursively pin the resolved CID. Off by default because Kubo's API
  // requires a one-time CORS allowlist entry for this extension origin.
  autoPinIpfsContent: boolean;
};

const KEY = "settings";

const DEFAULT: Settings = {
  onboardingComplete: false,
  interceptEthLimo: true,
  interceptW3Eth: true,
  ipfsGatewayHost: "localhost",
  ipfsGatewayPort: 8080,
  interceptGweiDomains: true,
  autoPinIpfsContent: false,
};

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY);
  const stored = (raw[KEY] ?? {}) as Partial<Settings> & { rpcUrls?: string[] };
  // Legacy installs stored a prioritized list. Only the first entry was ever
  // used, so collapse to the single field and drop the rest.
  if (stored.rpcUrl == null && Array.isArray(stored.rpcUrls) && stored.rpcUrls[0]) {
    stored.rpcUrl = stored.rpcUrls[0];
  }
  delete stored.rpcUrls;
  return { ...DEFAULT, ...stored };
}

export async function setSettings(next: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const merged = { ...cur, ...next };
  await chrome.storage.local.set({ [KEY]: merged });
  return merged;
}

export function onSettingsChanged(cb: (s: Settings) => void) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    cb({ ...DEFAULT, ...(changes[KEY].newValue ?? {}) });
  });
}
