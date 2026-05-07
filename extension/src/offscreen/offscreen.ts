import { createHeliosProvider, type HeliosProvider } from "@a16z/helios";
import type {
  HeliosBootstrapMsg,
  HeliosRequestMsg,
  HeliosResponse,
  HeliosShutdownMsg,
  HeliosStatus,
  HeliosStatusMsg,
} from "@/lib/helios-bridge";

// publicnode serves every beacon endpoint Helios touches:
//   - /eth/v1/beacon/headers/finalized (epoch-boundary root for bootstrap)
//   - /eth/v1/beacon/light_client/bootstrap/<root>
//   - /eth/v1/beacon/light_client/updates?start_period=&count=
//   - /eth/v2/beacon/blocks/<slot> (advance() hits this every ~12s to pull
//     the execution payload; without it the freshness-gate timestamp stays
//     at 0 and every eth_call rejects with "out of sync: <unix now> seconds
//     behind").
// Tried lodestar-mainnet.chainsafe.io (rate-limits /blocks/ with 429s) and
// www.lightclientdata.org (returns 503 on the REST API entirely) — both
// break the advance() loop or bootstrap.
const DEFAULT_CONSENSUS_RPC = "https://eth-beacon-chain.drpc.org";

let provider: HeliosProvider | null = null;
let bootPromise: Promise<void> | null = null;
let status: HeliosStatus = { state: "idle" };

async function fetchFreshCheckpoint(consensusRpc: string): Promise<string> {
  // Helios needs an epoch-boundary finalized block root — the consensus RPC
  // only serves `/light_client/bootstrap/<root>` for those. Different beacon
  // nodes expose this differently:
  //
  //   - Full nodes (publicnode, operationsolarstorm) expose
  //     `/eth/v1/beacon/states/head/finality_checkpoints` which gives the
  //     finalized checkpoint root directly.
  //   - Light-client-only nodes (lightclientdata.org) disable the state API
  //     but keep `/eth/v1/beacon/headers/finalized`, whose response includes
  //     `data.root` — also an epoch-boundary root (the consensus layer
  //     advances `finalized` only at epoch boundaries).
  //
  // Try the headers endpoint first — it's the broadly-supported one. Fall
  // back to finality_checkpoints for nodes that only expose that.
  const base = consensusRpc.replace(/\/$/, "");

  async function tryHeaders(): Promise<string | null> {
    const res = await fetch(`${base}/eth/v1/beacon/headers/finalized`, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { root?: string } };
    const root = json?.data?.root;
    return root && /^0x[0-9a-fA-F]{64}$/.test(root) ? root : null;
  }

  async function tryFinalityCheckpoints(): Promise<string | null> {
    const res = await fetch(
      `${base}/eth/v1/beacon/states/head/finality_checkpoints`,
      { signal: AbortSignal.timeout(15000), redirect: "error" },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { finalized?: { root?: string } };
    };
    const root = json?.data?.finalized?.root;
    return root && /^0x[0-9a-fA-F]{64}$/.test(root) ? root : null;
  }

  // Try finality_checkpoints first — it was verified to return an
  // epoch-boundary root (which /light_client/bootstrap/<root> requires) on
  // the full nodes we tested. Fall back to /headers/finalized for light-
  // client-only endpoints like lightclientdata.org that disable the state API.
  // Both should resolve to the same finalized checkpoint root in practice.
  let lastErr: unknown;
  for (const attempt of [tryFinalityCheckpoints, tryHeaders]) {
    try {
      const root = await attempt();
      if (root) return root;
    } catch (e) {
      lastErr = e;
    }
  }
  const suffix = lastErr instanceof Error ? `: ${lastErr.message}` : "";
  throw new Error(
    `consensus RPC ${base} did not serve a finalized block root via /headers/finalized or /states/head/finality_checkpoints${suffix}`,
  );
}

// Multi-source bootstrap anchor verification (opt-in). When the user has
// configured one or more verifier beacon RPCs in settings, the finalized root
// must come back byte-equal from the primary AND every verifier before we
// trust it. Defeats single-operator compromise of the bootstrap anchor — an
// attacker would have to control every configured beacon to forge it. Fails
// closed on disagreement or any individual fetch failure: a configured
// verifier is a deliberate trust requirement, not an opportunistic one.
//
// Slot-boundary edge case: parallel fetches across different beacons can land
// on either side of an epoch-boundary advance, producing a transient mismatch
// even when both endpoints are honest. The caller is expected to retry in
// that case (the fail-closed path returns a clear "disagreement" error and
// the next user-triggered boot picks up the next finalized root).
async function fetchAgreedCheckpoint(
  primary: string,
  verifiers: string[],
): Promise<string> {
  if (verifiers.length === 0) {
    return fetchFreshCheckpoint(primary);
  }
  const sources = [primary, ...verifiers];
  const settled = await Promise.allSettled(
    sources.map(async (url) => ({
      url,
      root: await fetchFreshCheckpoint(url),
    })),
  );
  const failures: string[] = [];
  const roots: { url: string; root: string }[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      roots.push(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failures.push(reason);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Bootstrap anchor verification failed — ${failures.length} of ${sources.length} beacon endpoints did not respond. ` +
        `When verifier RPCs are configured, every endpoint must answer. Failures: ${failures.join("; ")}`,
    );
  }
  const [first, ...rest] = roots;
  if (!first || rest.some((r) => r.root !== first.root)) {
    const breakdown = roots.map((r) => `${r.url}=${r.root}`).join("; ");
    throw new Error(
      `Bootstrap anchor verification failed — beacon endpoints returned different finalized roots. ` +
        `This may be a transient slot-boundary race (retry), or one of the endpoints is dishonest. ` +
        `Roots: ${breakdown}`,
    );
  }
  return first.root;
}

async function boot(config: HeliosBootstrapMsg["config"]): Promise<void> {
  if (provider && status.state === "synced" && status.executionRpc === config.executionRpc) {
    return;
  }
  if (bootPromise && status.executionRpc === config.executionRpc) {
    return bootPromise;
  }

  if (provider) {
    try {
      await provider.shutdown();
    } catch (e) {
      console.warn("[dapp3] helios shutdown error", e);
    }
    provider = null;
  }

  status = { state: "booting", executionRpc: config.executionRpc };

  bootPromise = (async () => {
    try {
      const consensus = config.consensusRpc ?? DEFAULT_CONSENSUS_RPC;

      // Helios's baked-in default checkpoint is old enough that no public
      // consensus RPC still serves it. Fetch a fresh finalized-block root from
      // the consensus RPC (and any configured verifier RPCs — see
      // fetchAgreedCheckpoint) and pass it through as the bootstrap anchor.
      let checkpoint = config.checkpoint;
      const verifiers = (config.consensusVerifiers ?? []).filter(
        (v) => v && v !== consensus,
      );
      if (!checkpoint) {
        try {
          checkpoint = await fetchAgreedCheckpoint(consensus, verifiers);
          if (verifiers.length > 0) {
            console.log(
              `[dapp3] fresh checkpoint (agreed across ${verifiers.length + 1} sources):`,
              checkpoint,
            );
          } else {
            console.log("[dapp3] fresh checkpoint:", checkpoint);
          }
        } catch (e) {
          throw new Error(
            `Failed to fetch a fresh checkpoint: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      // Helios with dbType: "localstorage" reads any previously-cached
      // checkpoint from localStorage and prefers it over the one we pass here.
      // A stale entry can put the provider into a state where wait_synced()
      // returns but the last-applied LC update timestamp is 0, causing every
      // eth_call to reject with "out of sync: <unix now> seconds behind".
      // Clear it so the fresh checkpoint we just fetched is what actually
      // bootstraps the provider.
      try {
        localStorage.clear();
      } catch (e) {
        console.warn("[dapp3] localStorage clear failed", e);
      }

      const p = await createHeliosProvider(
        {
          executionRpc: config.executionRpc,
          consensusRpc: consensus,
          checkpoint,
          network: "mainnet",
          dbType: "localstorage",
        },
        "ethereum",
      );
      provider = p;
      status = { state: "syncing", executionRpc: config.executionRpc };
      await p.waitSynced();
      status = { state: "synced", executionRpc: config.executionRpc };
      console.log("[dapp3] helios synced");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status = { state: "error", executionRpc: config.executionRpc, error: msg };
      provider = null;
      console.error("[dapp3] helios boot failed", e);
      throw e;
    }
  })();

  return bootPromise;
}

async function handleRequest(msg: HeliosRequestMsg): Promise<HeliosResponse> {
  if (!provider) {
    return { ok: false, error: "Helios not initialized" };
  }
  if (status.state !== "synced") {
    return { ok: false, error: `Helios not synced (${status.state})` };
  }
  try {
    const result = await provider.request({
      method: msg.method,
      params: msg.params as unknown[],
    });
    return { ok: true, result };
  } catch (e) {
    console.error(
      "[dapp3] helios provider.request failed",
      { method: msg.method, params: msg.params },
      e,
    );
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function shutdown() {
  if (provider) {
    try {
      await provider.shutdown();
    } catch (e) {
      console.warn("[dapp3] shutdown err", e);
    }
    provider = null;
  }
  bootPromise = null;
  status = { state: "idle" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  (async () => {
    try {
      if (msg.type === "helios-bootstrap") {
        await boot((msg as HeliosBootstrapMsg).config);
        sendResponse({ ok: true, status });
      } else if (msg.type === "helios-status") {
        void (msg as HeliosStatusMsg);
        sendResponse({ ok: true, status });
      } else if (msg.type === "helios-request") {
        const resp = await handleRequest(msg as HeliosRequestMsg);
        sendResponse(resp);
      } else if (msg.type === "helios-shutdown") {
        void (msg as HeliosShutdownMsg);
        await shutdown();
        sendResponse({ ok: true, status });
      } else {
        sendResponse({ ok: false, error: `unknown type ${msg.type}` });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  return true;
});

console.log("[dapp3] offscreen ready");
