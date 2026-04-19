import type {
  HeliosBootstrapMsg,
  HeliosRequestMsg,
  HeliosResponse,
  HeliosStatus,
  HeliosStatusMsg,
} from "@/lib/helios-bridge";
import { getSettings } from "@/lib/settings";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

let offscreenReady: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const hasDoc: boolean = await chrome.offscreen.hasDocument();
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
  })();
  try {
    await offscreenReady;
  } catch (e) {
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
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp as T);
    });
  });
}

const DEFAULT_CONSENSUS_RPC = "https://ethereum-beacon-api.publicnode.com";

async function ensureHostPermission(url: string): Promise<void> {
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
  const { rpcUrls, consensusRpc } = await getSettings();
  const executionRpc = rpcUrls[0];
  if (!executionRpc) throw new Error("No Ethereum RPC configured.");
  const consensus = consensusRpc || DEFAULT_CONSENSUS_RPC;

  await ensureHostPermission(executionRpc);
  await ensureHostPermission(consensus);

  const resp = await sendOffscreen<{
    ok: boolean;
    status: HeliosStatus;
    error?: string;
  }>({
    target: "offscreen",
    type: "helios-bootstrap",
    config: { executionRpc, consensusRpc: consensus },
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
        // error so we can actually see it.
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
