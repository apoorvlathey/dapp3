// Persisted cache of Helios-verified ENS → contenthash resolutions, keyed by
// lowercased ENS name. Entries are written only after a successful Helios
// resolve (never from a bypass-trusted path) so the cached value carries the
// same trust as the original navigation. On cache hit we redirect immediately
// and re-resolve in the background; if the fresh value differs, the banner
// surfaces an "updated content available" notice.

export type CachedResolve = {
  ensName: string;
  kind: "ipfs" | "ipns";
  value: string;
  resolvedAt: number;
};

const KEY = "resolveCache";

type CacheMap = Record<string, CachedResolve>;

async function readMap(): Promise<CacheMap> {
  const raw = await chrome.storage.local.get(KEY);
  return (raw[KEY] as CacheMap | undefined) ?? {};
}

export async function getCached(name: string): Promise<CachedResolve | null> {
  const lower = name.toLowerCase();
  const map = await readMap();
  return map[lower] ?? null;
}

export async function setCached(entry: CachedResolve): Promise<void> {
  const lower = entry.ensName.toLowerCase();
  const map = await readMap();
  map[lower] = { ...entry, ensName: lower };
  await chrome.storage.local.set({ [KEY]: map });
}

export async function clearCached(name: string): Promise<void> {
  const lower = name.toLowerCase();
  const map = await readMap();
  if (!(lower in map)) return;
  delete map[lower];
  await chrome.storage.local.set({ [KEY]: map });
}
