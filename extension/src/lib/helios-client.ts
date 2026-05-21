import type {
  HeliosBootstrapMsg,
  HeliosRequestMsg,
  HeliosResponse,
  HeliosStatus,
  HeliosStatusMsg,
} from "@/lib/helios-bridge";
import { getSettings } from "@/lib/settings";

const OFFSCREEN_PATH = "offscreen.html";

let offscreenReady: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) {
    console.log("[dapp3] ensureOffscreen: reusing cached promise");
    return offscreenReady;
  }
  console.log("[dapp3] ensureOffscreen: creating offscreen document");
  offscreenReady = (async () => {
    const hasDoc: boolean = await chrome.offscreen.hasDocument();
    console.log("[dapp3] ensureOffscreen: hasDocument =", hasDoc);
    if (hasDoc) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      reasons: [
        chrome.offscreen.Reason.LOCAL_STORAGE,
        chrome.offscreen.Reason.WORKERS,
      ],
      justification:
        "Hosts the Helios light client (WASM) which cannot run in a service worker.",
    });
    console.log("[dapp3] ensureOffscreen: createDocument resolved");
  })();
  try {
    await offscreenReady;
    console.log("[dapp3] ensureOffscreen: offscreen ready");
  } catch (e) {
    console.error("[dapp3] ensureOffscreen: failed", e);
    offscreenReady = null;
    throw e;
  }
}

async function sendOffscreen<T>(
  msg:
    | HeliosBootstrapMsg
    | HeliosRequestMsg
    | HeliosStatusMsg
    | { target: "offscreen"; type: "helios-shutdown" },
): Promise<T> {
  await ensureOffscreen();
  console.log("[dapp3] sendOffscreen: sending", msg.type);
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error("[dapp3] sendOffscreen: lastError for", msg.type, err.message);
        return reject(new Error(err.message));
      }
      console.log("[dapp3] sendOffscreen: response for", msg.type, resp);
      resolve(resp as T);
    });
  });
}

const DEFAULT_CONSENSUS_RPC = "https://ethereum-beacon-api.publicnode.com";

async function checkHostPermission(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const origin = `${parsed.origin}/*`;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) {
    throw new Error(
      `Host permission for ${parsed.origin} not granted. Open the extension options to grant it.`,
    );
  }
}

export async function requestHostPermission(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const origin = `${parsed.origin}/*`;
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`Host permission for ${parsed.origin} was not granted.`);
  }
}

export async function ensureHeliosBooted(): Promise<HeliosStatus> {
  console.log("[dapp3] ensureHeliosBooted: starting");
  const { rpcUrl, consensusRpc, consensusVerifiers, checkpoint } =
    await getSettings();
  if (!rpcUrl) throw new Error("No Ethereum RPC configured.");
  const executionRpc = rpcUrl;
  const consensus = consensusRpc || DEFAULT_CONSENSUS_RPC;
  console.log("[dapp3] ensureHeliosBooted: executionRpc =", executionRpc, "consensus =", consensus);

  await checkHostPermission(executionRpc);
  await checkHostPermission(consensus);

  // Verifiers must already have host permission — they were granted at
  // add-time in the options UI. Filter out anything we don't actually have
  // permission for so a stale settings entry can't wedge bootstrap; the user
  // sees a no-op rather than a permission failure mid-boot.
  const verifiers: string[] = [];
  for (const v of consensusVerifiers ?? []) {
    if (!v || v === consensus) continue;
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      continue;
    }
    const has = await chrome.permissions.contains({
      origins: [`${parsed.origin}/*`],
    });
    if (has) verifiers.push(v);
  }

  const resp = await sendOffscreen<{
    ok: boolean;
    status: HeliosStatus;
    error?: string;
  }>({
    target: "offscreen",
    type: "helios-bootstrap",
    config: {
      executionRpc,
      consensusRpc: consensus,
      consensusVerifiers: verifiers,
      checkpoint,
    },
  });
  if (!resp.ok) throw new Error(resp.error ?? "Helios bootstrap failed");
  return resp.status;
}

export async function getHeliosStatus(): Promise<HeliosStatus> {
  const resp = await sendOffscreen<{ ok: boolean; status: HeliosStatus }>({
    target: "offscreen",
    type: "helios-status",
  });
  return resp.status;
}

export async function heliosRequest<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const resp = await sendOffscreen<HeliosResponse<T>>({
    target: "offscreen",
    type: "helios-request",
    method,
    params,
  });
  if (!resp.ok) throw new Error(resp.error);
  return resp.result;
}

// The original reason from the most recent heliosRequest() failure. Used to
// recover the actual error after viem's CCIP-read fallback path mangles it
// into the misleading "import() is disallowed on ServiceWorkerGlobalScope".
// See IMPLEMENTATION.md §4.2.
let lastRpcError: { method: string; reason: string; ts: number } | null = null;

export function consumeLastRpcError(
  maxAgeMs = 2000,
): { method: string; reason: string } | null {
  if (!lastRpcError) return null;
  const age = Date.now() - lastRpcError.ts;
  const entry = lastRpcError;
  lastRpcError = null;
  if (age > maxAgeMs) return null;
  return { method: entry.method, reason: entry.reason };
}

export function heliosEip1193Provider() {
  return {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params?: unknown[];
    }) => {
      try {
        return await heliosRequest(method, params ?? []);
      } catch (e) {
        // Viem wraps this in a ContractFunctionExecutionError and — in an MV3
        // service worker — its catch path does `await import('ccip.js')` which
        // is disallowed in SW, masking the original reason. Log the raw Helios
        // error so we can actually see it, and stash it for the resolver to
        // recover via consumeLastRpcError().
        const reason = e instanceof Error ? e.message : String(e);
        lastRpcError = { method, reason, ts: Date.now() };
        console.error(
          "[dapp3] helios request failed",
          { method, params },
          e,
        );
        throw e;
      }
    },
  };
}

export async function shutdownHelios(): Promise<void> {
  try {
    await sendOffscreen({ target: "offscreen", type: "helios-shutdown" });
  } catch {
    // best-effort
  }
}
