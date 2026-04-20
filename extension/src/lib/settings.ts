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
};

const KEY = "settings";

const DEFAULT: Settings = {
  onboardingComplete: false,
  interceptEthLimo: true,
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
