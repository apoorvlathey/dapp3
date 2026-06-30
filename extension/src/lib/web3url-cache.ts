// Per-contract cache for ERC-4804 resolutions. Lets us skip the Kubo `add`
// round-trip (and its multipart upload) when the onchain HTML body hasn't
// changed since the last visit. Keyed by contract address; stores the sha256
// of the response body and the resulting CID.
//
// Two distinct caches exist for the web3 path:
//   1. This one — keyed by contract, used during resolution to dedupe Kubo
//      pins. The fingerprint is the *exact* sha256 of the body bytes, not the
//      CID; we don't compute IPFS CIDs locally in v1 (would require bundling
//      a UnixFS encoder; deferred per PRD §5.2).
//   2. The ENS-keyed cache in `src/lib/cache.ts`, used for sub-50ms first
//      paint on repeat visits to the same .eth name.
//
// Storage growth is bounded by `web3SizeCapBytes` and `web3EntryBudget` in
// settings (PRD §5.4 / §7). When inserting an entry would exceed either
// budget the LRU entry is evicted: MFS path removed, pin dropped, cache
// entry deleted. Eviction lives in the SW so it can talk to Kubo.

import { getSettings } from "./settings";

export type Web3CacheEntry = {
  contractAddress: `0x${string}`;
  contentHash: string;
  cid: string;
  bodyLen: number;
  lastAccess: number;
  // True when the entry was populated from a direct-RPC resolve. Such entries
  // can dedupe Kubo adds after a fresh fetch, but must not become verified-mode
  // instant redirects without a Helios fetch first.
  trustedDirectly?: boolean;
  // ENS name that produced this entry — first-write-wins. Cosmetic only;
  // surfaces in the options page list so users can identify pinned dapps.
  ensName?: string;
};

const KEY = "web3UrlCache";

type CacheMap = Record<string, Web3CacheEntry>;

async function readMap(): Promise<CacheMap> {
  const raw = await chrome.storage.local.get(KEY);
  return (raw[KEY] as CacheMap | undefined) ?? {};
}

async function writeMap(map: CacheMap): Promise<void> {
  await chrome.storage.local.set({ [KEY]: map });
}

function normaliseAddr(address: string): string {
  return address.toLowerCase();
}

export async function getWeb3CacheEntry(
  address: string,
): Promise<Web3CacheEntry | null> {
  const map = await readMap();
  return map[normaliseAddr(address)] ?? null;
}

export async function setWeb3CacheEntry(entry: Web3CacheEntry): Promise<void> {
  const map = await readMap();
  map[normaliseAddr(entry.contractAddress)] = {
    ...entry,
    contractAddress: normaliseAddr(entry.contractAddress) as `0x${string}`,
  };
  await writeMap(map);
}

export async function bumpWeb3LastAccess(address: string): Promise<void> {
  const map = await readMap();
  const key = normaliseAddr(address);
  const entry = map[key];
  if (!entry) return;
  entry.lastAccess = Date.now();
  await writeMap(map);
}

export async function listWeb3Entries(): Promise<Web3CacheEntry[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => b.lastAccess - a.lastAccess);
}

export async function removeWeb3CacheEntry(
  address: string,
): Promise<Web3CacheEntry | null> {
  const map = await readMap();
  const key = normaliseAddr(address);
  const entry = map[key];
  if (!entry) return null;
  delete map[key];
  await writeMap(map);
  return entry;
}

// Pick the LRU entries (by ascending lastAccess) that, when removed, drop
// total size below sizeCapBytes AND total count to <= entryBudget. Returns
// the entries to evict; caller is responsible for also unpinning + clearing
// MFS in Kubo before deleting the cache row (see SW evictWeb3Entries).
export type EvictionPlan = {
  toEvict: Web3CacheEntry[];
  // Remaining state if all `toEvict` are removed.
  remainingBytes: number;
  remainingCount: number;
};

export async function planEviction(
  newEntryBytes: number,
  budgets: { sizeCapBytes: number; entryBudget: number },
): Promise<EvictionPlan> {
  const map = await readMap();
  const all = Object.values(map).sort((a, b) => a.lastAccess - b.lastAccess);
  let totalBytes = all.reduce((acc, e) => acc + e.bodyLen, 0) + newEntryBytes;
  let totalCount = all.length + 1;
  const toEvict: Web3CacheEntry[] = [];
  for (const entry of all) {
    if (
      totalBytes <= budgets.sizeCapBytes &&
      totalCount <= budgets.entryBudget
    ) {
      break;
    }
    toEvict.push(entry);
    totalBytes -= entry.bodyLen;
    totalCount -= 1;
  }
  return {
    toEvict,
    remainingBytes: totalBytes,
    remainingCount: totalCount,
  };
}

export async function getWeb3Budgets(): Promise<{
  sizeCapBytes: number;
  entryBudget: number;
}> {
  const s = await getSettings();
  return {
    sizeCapBytes: s.web3SizeCapBytes ?? DEFAULT_WEB3_SIZE_CAP_BYTES,
    entryBudget: s.web3EntryBudget ?? DEFAULT_WEB3_ENTRY_BUDGET,
  };
}

export const DEFAULT_WEB3_SIZE_CAP_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_WEB3_ENTRY_BUDGET = 200;

export async function sha256Hex(body: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    body as BufferSource,
  );
  const arr = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += (arr[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export function mfsPathFor(
  contractAddress: string,
  contentHash: string,
): string {
  return `/dapp3/web3/${normaliseAddr(contractAddress)}/${contentHash}`;
}
