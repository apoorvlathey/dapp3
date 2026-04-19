export type Settings = {
  rpcUrls: string[];
  consensusRpc?: string;
  checkpoint?: string;
  onboardingComplete?: boolean;
  // Intercept `*.eth.limo` navigations and route them through local resolution
  // (Helios + Kubo) instead of the public eth.limo gateway. Default true; gets
  // forced false at onboarding if Kubo isn't reachable, since intercepting
  // without a working IPFS node would just break eth.limo links for the user.
  interceptEthLimo: boolean;
};

const KEY = "settings";

const DEFAULT: Settings = {
  rpcUrls: [],
  onboardingComplete: false,
  interceptEthLimo: true,
};

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY);
  return { ...DEFAULT, ...(raw[KEY] ?? {}) };
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
