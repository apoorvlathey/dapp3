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
  ensureHeliosBooted,
  heliosEip1193Provider,
  getHeliosStatus,
} from "@/lib/helios-client";
import type { HeliosStatus } from "@/lib/helios-bridge";
import {
  classifyError,
  recordFailure,
  recordSuccess,
} from "@/lib/rpc-stats";

const RESOLVER_ABI = parseAbi([
  "function contenthash(bytes32 node) view returns (bytes)",
]);

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

  const { rpcUrls } = await getSettings();
  const rpc = rpcUrls[0];
  if (!rpc) {
    return {
      ok: false,
      error: "No Ethereum RPC configured. Add one in the extension options.",
    };
  }

  let client: PublicClient;
  let trustedDirectly = false;

  if (opts.bypassHelios) {
    client = getDirectClient(rpc);
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

  const start = performance.now();
  const report = async (
    kind: "success" | "failure",
    err?: { reason: string; kind: ReturnType<typeof classifyError>["kind"] },
  ) => {
    if (kind === "success") {
      await recordSuccess(rpc, performance.now() - start);
    } else if (err) {
      await recordFailure(rpc, err.kind, err.reason);
    }
  };

  let resolverAddress: `0x${string}`;
  try {
    resolverAddress = (await client.getEnsResolver({
      name: lower,
    })) as `0x${string}`;
  } catch (e) {
    const c = classifyError(e);
    await report("failure", c);
    return { ok: false, error: `No ENS resolver for ${lower}: ${c.reason}` };
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
    const c = classifyError(e);
    await report("failure", c);
    return {
      ok: false,
      error: `Failed to read contenthash for ${lower}: ${c.reason}`,
    };
  }

  if (!raw || raw === "0x") {
    await report("success");
    return { ok: false, error: `${lower} has no contenthash set.` };
  }

  let codec: string | undefined;
  let decoded: string;
  try {
    codec = getCodec(raw);
    decoded = decodeContentHash(raw);
  } catch (e) {
    await report("success"); // RPC side worked; decode is a local issue
    return { ok: false, error: `Cannot decode contenthash: ${describe(e)}` };
  }

  if (codec !== "ipfs" && codec !== "ipns") {
    await report("success");
    return {
      ok: false,
      error: `Unsupported contenthash codec "${codec}". v1 supports ipfs / ipns only.`,
    };
  }

  await report("success");
  return {
    ok: true,
    kind: codec,
    value: decoded,
    ensName: lower,
    trustedDirectly,
  };
}

export async function probeRpc(url: string): Promise<{
  ok: boolean;
  latencyMs?: number;
  blockNumber?: bigint;
  error?: string;
}> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(url, { retryCount: 0, timeout: 6_000 }),
  });
  const start = performance.now();
  try {
    const blockNumber = await client.getBlockNumber();
    const latencyMs = performance.now() - start;
    await recordSuccess(url, latencyMs);
    return { ok: true, latencyMs, blockNumber };
  } catch (e) {
    const c = classifyError(e);
    await recordFailure(url, c.kind, c.reason);
    return { ok: false, error: c.reason };
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
