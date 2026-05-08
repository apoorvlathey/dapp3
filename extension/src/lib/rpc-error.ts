// Translate raw Helios / RPC error strings into messages a user can act on.
// Imported by both the SW (resolver) and the offscreen doc (status reporter),
// so it must stay pure and free of chrome.* APIs.

export function humanizeRpcError(reason: string): string {
  if (!reason) return "Unknown error";

  const httpMatch = reason.match(/HTTP error (\d+)/i);
  if (httpMatch) {
    const code = httpMatch[1];
    return `Your Ethereum RPC returned HTTP ${code}. The URL may be wrong, or the endpoint is down. Open Options to update it.`;
  }

  const oosMatch = reason.match(/out of sync:\s*(\d+)\s*seconds behind/i);
  if (oosMatch) {
    return `Helios is out of sync with the consensus chain (${oosMatch[1]}s behind). The consensus RPC's blocks endpoint may be rate-limiting. Try again, or switch the consensus RPC in Options.`;
  }

  // viem's CCIP-read fallback path masks the real reason with this message in
  // the MV3 service worker. If we ever surface it to the user untranslated,
  // it's pure noise — fall back to a generic RPC-failure message.
  if (/import\(\) is disallowed on ServiceWorkerGlobalScope/i.test(reason)) {
    return "The Ethereum RPC call failed. The configured RPC may be unreachable. Open Options to check it.";
  }

  return reason;
}
