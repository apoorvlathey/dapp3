// Persisted cache of Helios-verified ENS → contenthash resolutions, keyed by
// lowercased ENS name. Entries are written only after a successful Helios
// resolve (never from a bypass-trusted path) so the cached value carries the
// same trust as the original navigation. On cache hit we redirect immediately
// and re-resolve in the background; if the fresh value differs, the banner
// surfaces an "updated content available" notice.
//
// Two cache flavours coexist:
//   - ipfs / ipns: `value` is the contenthash itself (CID or IPNS name).
//   - web3 (ERC-4804): `value` is the IPFS CID produced after pinning the
//     onchain HTML to Kubo. `contractAddress` is also stored so a refresh
//     can re-fetch from the same contract; revalidation is keyed off
//     `web3url-cache.ts` (per-contract sha256 fingerprint), this entry just
//     gives us a synchronous redirect target on next visit.

import { encodeIpnsLabel } from "./gateway";
import type { ResolveKind } from "./messaging";

export type CachedResolve = {
  ensName: string;
  kind: ResolveKind;
  value: string;
  resolvedAt: number;
  contractAddress?: `0x${string}`;
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

// Reverse lookup: find an entry whose contenthash would produce the given
// gateway subdomain label. Used when the user navigates directly to
// `<label>.ipfs.localhost` / `<label>.ipns.localhost` (e.g. from a bookmark)
// so the banner can still show which ENS name previously mapped here.
//
// web3 entries have a CID `value` and serve under the ipfs subdomain (see
// gateway.ts), so a label lookup with kind="ipfs" matches both ipfs and web3
// rows. If multiple ENS names mapped to the same CID, the iteration returns
// whichever the storage iterator yields first — that's fine for banner
// identity, since they all point at the same content anyway.
export async function findCachedByGatewayLabel(
  kind: "ipfs" | "ipns",
  label: string,
): Promise<CachedResolve | null> {
  const map = await readMap();
  const needle = label.toLowerCase();
  for (const entry of Object.values(map)) {
    const matchesKind =
      kind === "ipns"
        ? entry.kind === "ipns"
        : entry.kind === "ipfs" || entry.kind === "web3";
    if (!matchesKind) continue;
    const entryLabel =
      entry.kind === "ipns" ? encodeIpnsLabel(entry.value) : entry.value;
    if (entryLabel.toLowerCase() === needle) return entry;
  }
  return null;
}

export async function clearCached(name: string): Promise<void> {
  const lower = name.toLowerCase();
  const map = await readMap();
  if (!(lower in map)) return;
  delete map[lower];
  await chrome.storage.local.set({ [KEY]: map });
}
