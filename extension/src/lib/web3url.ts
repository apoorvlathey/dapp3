// ERC-4804 / ERC-5219 fallback. When an ENS name has no IPFS contenthash but
// resolves to a contract that implements ERC-5219 manual mode, we fetch the
// HTML body through Helios-verified eth_calls. The caller pins the bytes to
// the user's Kubo node and redirects the tab to <cid>.ipfs.localhost:8080.
//
// v1 scope (per PRD_ERC4804.md §3): manual / 5219 mode only, index route
// (request([], [])) only, HTML responses only. Status codes other than 200
// surface as errors. Auto mode + path routing + non-HTML are deferred.

import { parseAbi, type PublicClient } from "viem";

export type Web3FetchResult = {
  status: number;
  body: Uint8Array;
  contentType: string | null;
};

export type Web3FetchErrorKind =
  | { kind: "not-a-contract" }
  | { kind: "unsupported-mode"; mode: string }
  | { kind: "call-reverted"; cause: string }
  | { kind: "bad-status"; status: number }
  | { kind: "body-too-large"; size: number };

export class Web3FetchError extends Error {
  constructor(public detail: Web3FetchErrorKind) {
    super(describeWeb3Error(detail));
  }
}

export function describeWeb3Error(d: Web3FetchErrorKind): string {
  switch (d.kind) {
    case "not-a-contract":
      return "Resolved address is not a contract (no code).";
    case "unsupported-mode":
      return d.mode
        ? `Unsupported resolveMode "${d.mode}" (v1 supports manual / 5219 only).`
        : "Contract did not implement resolveMode() (auto mode is not supported in v1).";
    case "call-reverted":
      return `Contract is not ERC-4804 compatible: request() reverted (${d.cause}).`;
    case "bad-status":
      return `ERC-5219 request returned status ${d.status} (v1 supports 200 only).`;
    case "body-too-large":
      return `Response body is ${d.size} bytes; v1 caps at ${MAX_BODY_BYTES} bytes.`;
  }
}

// ERC-4804 §4.1 resolveMode — bytes32, ASCII null-padded.
const RESOLVE_MODE_ABI = parseAbi([
  "function resolveMode() view returns (bytes32)",
]);

// ERC-5219 — KeyValue is (string,string). The named-field form `(string key,
// string value)` would decode differently in viem; the unnamed form is what
// the spec wires onchain and what zRouter (and others) implement.
const REQUEST_ABI = parseAbi([
  "function request(string[] resource, (string,string)[] params) view returns (uint16, string, (string,string)[])",
]);

const MAX_BODY_BYTES = 1 * 1024 * 1024;

function bytes32ToString(value: `0x${string}`): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

export async function fetchErc4804(
  client: PublicClient,
  address: `0x${string}`,
): Promise<Web3FetchResult> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    throw new Web3FetchError({ kind: "not-a-contract" });
  }

  // resolveMode() is optional per ERC-4804: missing => auto mode (default).
  // We don't support auto mode in v1, so a missing or non-{manual,5219} value
  // surfaces as unsupported-mode. A revert here is treated the same as
  // missing implementation.
  let mode = "";
  try {
    const raw = (await client.readContract({
      address,
      abi: RESOLVE_MODE_ABI,
      functionName: "resolveMode",
    })) as `0x${string}`;
    mode = bytes32ToString(raw);
  } catch {
    /* fall through with empty mode */
  }
  if (mode !== "5219" && mode !== "manual") {
    throw new Web3FetchError({ kind: "unsupported-mode", mode });
  }

  let result: readonly [number, string, ReadonlyArray<readonly [string, string]>];
  try {
    result = (await client.readContract({
      address,
      abi: REQUEST_ABI,
      functionName: "request",
      args: [[], []],
    })) as readonly [number, string, ReadonlyArray<readonly [string, string]>];
  } catch (e) {
    throw new Web3FetchError({
      kind: "call-reverted",
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  const [status, bodyStr, headers] = result;
  if (status !== 200) {
    throw new Web3FetchError({ kind: "bad-status", status });
  }

  // Round-tripping through TextEncoder is lossless for HTML/UTF-8, which is
  // the v1 scope. For binary 5219 responses (PNG, etc.) we'd need to decode
  // the raw eth_call return ourselves; deferred to the non-HTML milestone.
  const body = new TextEncoder().encode(bodyStr);
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new Web3FetchError({
      kind: "body-too-large",
      size: body.byteLength,
    });
  }

  let contentType: string | null = null;
  for (const h of headers) {
    if (h[0].toLowerCase() === "content-type") {
      contentType = h[1];
      break;
    }
  }

  return { status, body, contentType };
}
