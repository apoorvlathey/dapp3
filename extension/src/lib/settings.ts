export type Settings = {
  rpcUrl?: string;
  consensusRpc?: string;
  checkpoint?: string;
  onboardingComplete?: boolean;
  // Intercept `*.eth.limo` and `*.eth.link` navigations and route them through
  // local resolution (Helios + Kubo) instead of the public gateways. Default
  // true; gets forced false at onboarding if Kubo isn't reachable, since
  // intercepting without a working IPFS node would just break those links for
  // the user. Name is historical — it governs both eth.limo and eth.link.
  interceptEthLimo: boolean;
  // Intercept `0x<40hex>.w3eth.io` navigations and route the contract address
  // through local ERC-4804 resolution. Same default-true / Kubo-gated story as
  // interceptEthLimo. The subdomain is the contract address directly, so the
  // resolver skips ENS lookup and goes straight to the ERC-4804 fetch path.
  interceptW3Eth: boolean;
  // ERC-4804 cache budgets. See PRD_ERC4804.md §5.4 / §7 / W4. Both bound
  // total Kubo storage used by web3:// dapps; LRU eviction kicks in when
  // either is exceeded. Defaults are exported from web3url-cache.ts.
  web3SizeCapBytes?: number;
  web3EntryBudget?: number;
  // Minimum interval (ms) between background revalidations of the same
  // ERC-4804 contract. Keeps Helios load light on heavy users by skipping
  // the eth_call when a recent revalidation has already happened. See PRD §5.3.
  web3RevalidateMinIntervalMs?: number;
};

const KEY = "settings";

const DEFAULT: Settings = {
  onboardingComplete: false,
  interceptEthLimo: true,
  interceptW3Eth: true,
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
