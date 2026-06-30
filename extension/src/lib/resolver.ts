import {
  createPublicClient,
  custom,
  http,
  namehash,
  parseAbi,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { decode as decodeContentHash, getCodec } from "@ensdomains/content-hash";
import { getSettings } from "@/lib/settings";
import type { ResolveResponse } from "@/lib/messaging";
import {
  consumeLastRpcError,
  ensureHeliosBooted,
  heliosEip1193Provider,
  getHeliosStatus,
} from "@/lib/helios-client";
import { humanizeRpcError } from "@/lib/rpc-error";
import type { HeliosStatus } from "@/lib/helios-bridge";
import { fetchErc4804, Web3FetchError } from "@/lib/web3url";
import { addToKubo, KuboPinError, removeMfsPath, unpinFromKubo } from "@/lib/kubo";
import {
  bumpWeb3LastAccess,
  getWeb3Budgets,
  getWeb3CacheEntry,
  mfsPathFor,
  planEviction,
  removeWeb3CacheEntry,
  setWeb3CacheEntry,
  sha256Hex,
} from "@/lib/web3url-cache";

const RESOLVER_ABI = parseAbi([
  "function contenthash(bytes32 node) view returns (bytes)",
  "function addr(bytes32 node) view returns (address)",
]);

// Gwei Name Service (GNS) NameNFT — mainnet (same address on Sepolia). Unlike
// ENS, the NameNFT is its *own* ENS-style resolver: it exposes
// `contenthash(bytes32 node)` directly (the tokenId is the ENS namehash of the
// full name), so there's no registry / UniversalResolver hop — resolution is a
// single eth_call against this address. The contenthash is stored in the same
// EIP-1577 form ENS uses (`0xe301 || <cidv1>`), so the same decoder handles it.
// See github.com/lucadonnoh/gwei-names.
const GWEI_NAMENFT = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6" as const;

let heliosClientCache: PublicClient | null = null;
let directClientCache: { url: string; client: PublicClient } | null = null;

function getHeliosClient(): PublicClient {
  if (heliosClientCache) return heliosClientCache;
  heliosClientCache = createPublicClient({
    chain: mainnet,
    transport: custom(heliosEip1193Provider()),
  });
  return heliosClientCache;
}

function getDirectClient(url: string): PublicClient {
  if (directClientCache && directClientCache.url === url) {
    return directClientCache.client;
  }
  const client = createPublicClient({
    chain: mainnet,
    transport: http(url, { retryCount: 0, timeout: 8_000 }),
  });
  directClientCache = { url, client };
  return client;
}

export type ResolveOptions = {
  /**
   * When true, do not go through Helios for this call; use the first user RPC
   * directly. Surfaces as "RPC-trusted" in the banner so the user knows.
   */
  bypassHelios?: boolean;
};

export async function getOrStartHelios(): Promise<HeliosStatus> {
  // Fire-and-forget start if idle; otherwise just read.
  try {
    return await ensureHeliosBooted();
  } catch (e) {
    // Caller decides how to surface.
    throw e;
  }
}

export async function currentHeliosStatus(): Promise<HeliosStatus | null> {
  try {
    return await getHeliosStatus();
  } catch {
    return null;
  }
}

export async function resolveEns(
  name: string,
  opts: ResolveOptions = {},
): Promise<ResolveResponse> {
  const lower = name.toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)+eth$/.test(lower)) {
    return { ok: false, error: `not a .eth name: ${name}` };
  }

  const { rpcUrl } = await getSettings();
  if (!rpcUrl) {
    return {
      ok: false,
      error: "No Ethereum RPC configured. Set one in the extension options.",
    };
  }

  let client: PublicClient;
  let trustedDirectly = false;

  if (opts.bypassHelios) {
    client = getDirectClient(rpcUrl);
    trustedDirectly = true;
  } else {
    try {
      const status = await ensureHeliosBooted();
      if (status.state !== "synced") {
        return {
          ok: false,
          error: `Helios is ${status.state}. Wait for sync or choose "bypass Helios".`,
        };
      }
      client = getHeliosClient();
    } catch (e) {
      return {
        ok: false,
        error: `Helios bootstrap failed: ${describe(e)}`,
      };
    }
  }

  let resolverAddress: `0x${string}`;
  try {
    resolverAddress = (await client.getEnsResolver({
      name: lower,
    })) as `0x${string}`;
  } catch (e) {
    return {
      ok: false,
      error: `No ENS resolver for ${lower}: ${describeRpcFailure(e)}`,
    };
  }

  let raw: `0x${string}`;
  try {
    raw = await client.readContract({
      address: resolverAddress,
      abi: RESOLVER_ABI,
      functionName: "contenthash",
      args: [namehash(lower)],
    });
  } catch (e) {
    return {
      ok: false,
      error: `Failed to read contenthash for ${lower}: ${describeRpcFailure(e)}`,
    };
  }

  // Contenthash branch: ipfs / ipns are the primary path.
  let contenthashUsable = !!raw && raw !== "0x";
  let codec: string | undefined;
  let decoded: string | undefined;
  if (contenthashUsable) {
    try {
      codec = getCodec(raw);
      decoded = decodeContentHash(raw);
    } catch {
      contenthashUsable = false;
    }
  }
  if (
    contenthashUsable &&
    decoded != null &&
    (codec === "ipfs" || codec === "ipns")
  ) {
    return {
      ok: true,
      kind: codec,
      value: decoded,
      ensName: lower,
      trustedDirectly,
    };
  }

  // ERC-4804 fallback: read addr() from the same resolver. If the address is
  // a contract that implements ERC-5219 manual mode, fetch its HTML and pin
  // it to local Kubo so we can serve via <cid>.ipfs.localhost. See
  // PRD_ERC4804.md for scope.
  let address: `0x${string}`;
  try {
    address = (await client.readContract({
      address: resolverAddress,
      abi: RESOLVER_ABI,
      functionName: "addr",
      args: [namehash(lower)],
    })) as `0x${string}`;
  } catch (e) {
    const detail = describeRpcFailure(e);
    return {
      ok: false,
      error: contenthashUsable
        ? `Unsupported contenthash codec "${codec}" and addr() failed: ${detail}`
        : `${lower} has no contenthash and addr() failed: ${detail}`,
    };
  }

  if (!address || /^0x0+$/i.test(address)) {
    return {
      ok: false,
      error: contenthashUsable
        ? `Unsupported contenthash codec "${codec}". v1 supports ipfs / ipns / ERC-4804.`
        : `${lower} has no contenthash and no addr record set.`,
    };
  }

  return await fetchPinAndCacheErc4804(client, address, lower, trustedDirectly);
}

/** True for a fully-qualified `.gwei` name (e.g. `donnoh.gwei`, `a.b.gwei`). */
export function isGweiName(name: string): boolean {
  return /^(?:[a-z0-9-]+\.)+gwei$/.test(name.toLowerCase());
}

// Resolve a `.gwei` name to its IPFS/IPNS contenthash, verified through Helios
// exactly like resolveEns. Simpler than ENS: the GNS NameNFT is its own
// resolver, so we skip the registry/UniversalResolver lookup and read
// contenthash(namehash(name)) straight off the NameNFT in one eth_call. No
// ERC-4804 fallback for v1 — `.gwei` serves ipfs/ipns contenthashes only.
export async function resolveGwei(
  name: string,
  opts: ResolveOptions = {},
): Promise<ResolveResponse> {
  const lower = name.toLowerCase();
  if (!isGweiName(lower)) {
    return { ok: false, error: `not a .gwei name: ${name}` };
  }

  const { rpcUrl } = await getSettings();
  if (!rpcUrl) {
    return {
      ok: false,
      error: "No Ethereum RPC configured. Set one in the extension options.",
    };
  }

  let client: PublicClient;
  let trustedDirectly = false;
  if (opts.bypassHelios) {
    client = getDirectClient(rpcUrl);
    trustedDirectly = true;
  } else {
    try {
      const status = await ensureHeliosBooted();
      if (status.state !== "synced") {
        return {
          ok: false,
          error: `Helios is ${status.state}. Wait for sync or choose "bypass Helios".`,
        };
      }
      client = getHeliosClient();
    } catch (e) {
      return { ok: false, error: `Helios bootstrap failed: ${describe(e)}` };
    }
  }

  let raw: `0x${string}`;
  try {
    raw = await client.readContract({
      address: GWEI_NAMENFT,
      abi: RESOLVER_ABI,
      functionName: "contenthash",
      args: [namehash(lower)],
    });
  } catch (e) {
    return {
      ok: false,
      error: `Failed to read contenthash for ${lower}: ${describeRpcFailure(e)}`,
    };
  }

  if (!raw || raw === "0x") {
    return { ok: false, error: `${lower} has no website (contenthash) set.` };
  }

  let codec: string | undefined;
  let decoded: string | undefined;
  try {
    codec = getCodec(raw);
    decoded = decodeContentHash(raw);
  } catch (e) {
    return {
      ok: false,
      error: `Failed to decode contenthash for ${lower}: ${describe(e)}`,
    };
  }

  if (decoded != null && (codec === "ipfs" || codec === "ipns")) {
    return {
      ok: true,
      kind: codec,
      value: decoded,
      ensName: lower,
      trustedDirectly,
    };
  }
  return {
    ok: false,
    error: `Unsupported contenthash codec "${codec ?? "unknown"}" for ${lower}. .gwei sites serve ipfs / ipns.`,
  };
}

// Resolve a raw 0x contract address as an ERC-4804 dapp, skipping ENS lookup.
// Used for ERC-4804 hosted-gateway interception (`w3eth.io` / mainnet
// `w3link.io`) and the homepage's address-mode input. The "ensName" carried on
// the response is the lowercased address itself, since there is no associated
// ENS name for this navigation.
export async function resolveContractAddress(
  address: string,
  opts: ResolveOptions = {},
): Promise<ResolveResponse> {
  const lower = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(lower)) {
    return { ok: false, error: `not a contract address: ${address}` };
  }

  const { rpcUrl } = await getSettings();
  if (!rpcUrl) {
    return {
      ok: false,
      error: "No Ethereum RPC configured. Set one in the extension options.",
    };
  }

  let client: PublicClient;
  let trustedDirectly = false;

  if (opts.bypassHelios) {
    client = getDirectClient(rpcUrl);
    trustedDirectly = true;
  } else {
    try {
      const status = await ensureHeliosBooted();
      if (status.state !== "synced") {
        return {
          ok: false,
          error: `Helios is ${status.state}. Wait for sync or choose "bypass Helios".`,
        };
      }
      client = getHeliosClient();
    } catch (e) {
      return {
        ok: false,
        error: `Helios bootstrap failed: ${describe(e)}`,
      };
    }
  }

  return await fetchPinAndCacheErc4804(
    client,
    lower as `0x${string}`,
    lower,
    trustedDirectly,
  );
}

// Shared ERC-4804 path: fetch the contract body via Helios, sha256-dedupe
// against the per-contract cache, pin to local Kubo if changed, evict LRU
// entries to fit budget. Used by both ENS resolution (when contenthash is
// missing) and direct-address resolution (ERC-4804 gateway / homepage 0x input).
async function fetchPinAndCacheErc4804(
  client: PublicClient,
  address: `0x${string}`,
  ensName: string,
  trustedDirectly: boolean,
): Promise<ResolveResponse> {
  let body: Uint8Array;
  let contentType: string | null;
  try {
    const fetched = await fetchErc4804(client, address);
    body = fetched.body;
    contentType = fetched.contentType;
  } catch (e) {
    if (e instanceof Web3FetchError) {
      return { ok: false, error: `web3-${e.detail.kind}: ${e.message}` };
    }
    return { ok: false, error: `ERC-4804 probe failed: ${describeRpcFailure(e)}` };
  }

  if (contentType && !/^\s*text\/html(?:\s*;|\s*$)/i.test(contentType)) {
    return {
      ok: false,
      error: `web3-non-html: contract returned content-type "${contentType}" (v1 serves text/html only).`,
    };
  }

  const contractAddress = address.toLowerCase() as `0x${string}`;
  let contentHash: string;
  try {
    contentHash = await sha256Hex(body);
  } catch (e) {
    return { ok: false, error: `sha256 failed: ${describe(e)}` };
  }

  const existing = await getWeb3CacheEntry(contractAddress).catch(() => null);
  if (existing && existing.contentHash === contentHash) {
    bumpWeb3LastAccess(contractAddress).catch(() => undefined);
    return {
      ok: true,
      kind: "web3",
      value: existing.cid,
      ensName,
      trustedDirectly,
      contractAddress,
    };
  }

  let cid: string;
  try {
    const budgets = await getWeb3Budgets();
    const plan = await planEviction(body.byteLength, budgets);
    for (const stale of plan.toEvict) {
      await evictWeb3(stale).catch((e) =>
        console.warn(`[dapp3] eviction failed for ${stale.contractAddress}`, e),
      );
    }
    if (existing && existing.cid !== "") {
      await evictWeb3(existing).catch((e) =>
        console.warn("[dapp3] swap eviction failed", e),
      );
    }
    const pinned = await addToKubo(body, {
      mfsPath: mfsPathFor(contractAddress, contentHash),
    });
    cid = pinned.cid;
  } catch (e) {
    if (e instanceof KuboPinError) {
      if (e.detail.kind === "cors") {
        return {
          ok: false,
          error: `web3-pin-failed: ${e.message}`,
          code: "kubo-cors-blocked",
        };
      }
      return { ok: false, error: `web3-pin-failed: ${e.message}` };
    }
    return { ok: false, error: `web3-pin-failed: ${describe(e)}` };
  }

  await setWeb3CacheEntry({
    contractAddress,
    contentHash,
    cid,
    bodyLen: body.byteLength,
    lastAccess: Date.now(),
    ensName,
  }).catch((e) => console.warn("[dapp3] web3 cache write failed", e));

  return {
    ok: true,
    kind: "web3",
    value: cid,
    ensName,
    trustedDirectly,
    contractAddress,
  };
}

async function evictWeb3(entry: {
  contractAddress: `0x${string}`;
  contentHash: string;
  cid: string;
}) {
  // Best-effort: failures here just leak storage on the user's Kubo node;
  // they don't affect serving. The cache row is dropped regardless so the
  // chrome.storage map stays in sync with our intent.
  await Promise.allSettled([
    unpinFromKubo(entry.cid),
    removeMfsPath(mfsPathFor(entry.contractAddress, entry.contentHash)),
  ]);
  await removeWeb3CacheEntry(entry.contractAddress).catch(() => undefined);
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Prefer the original Helios reason (stashed by heliosEip1193Provider) over
// viem's wrapped/masked text. If no recent RPC error is recorded, fall back
// to the caught error's message, then humanize whatever we end up with.
function describeRpcFailure(e: unknown): string {
  const stashed = consumeLastRpcError();
  const raw = stashed?.reason ?? describe(e);
  return humanizeRpcError(raw);
}
