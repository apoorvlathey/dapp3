// Kubo HTTP API helpers. The gateway on :8080 is what serves content; the
// API on :5001 is what we use to *write* content (pinning ERC-4804 bodies
// for serving). Kubo's API rejects browser-originated requests whose Origin
// isn't on its allowlist (CSRF / DNS-rebinding defense). Users who want
// ERC-4804 support need to allow the extension origin in Kubo's config:
//
//   ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin \
//     '["chrome-extension://<EXTENSION_ID>", "http://localhost:8080"]'
//   ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods \
//     '["POST"]'
//
// On a CORS rejection we surface KuboPinError so the caller can map to the
// extension's web3-pin-failed error page with a concrete fix message.

const KUBO_API_BASE = "http://127.0.0.1:5001";

export type KuboPinErrorKind =
  | { kind: "unreachable"; cause: string }
  | { kind: "cors"; cause: string }
  | { kind: "http"; status: number; body: string }
  | { kind: "parse"; body: string };

export class KuboPinError extends Error {
  constructor(public detail: KuboPinErrorKind) {
    super(describeKuboPinError(detail));
  }
}

export function describeKuboPinError(d: KuboPinErrorKind): string {
  switch (d.kind) {
    case "unreachable":
      return `Kubo API at ${KUBO_API_BASE} is unreachable: ${d.cause}. Is IPFS Desktop running?`;
    case "cors":
      return `Kubo rejected the request (CORS / Origin not allowed): ${d.cause}. Allow the extension origin in Kubo's API.HTTPHeaders.Access-Control-Allow-Origin.`;
    case "http":
      return `Kubo /api/v0/add returned ${d.status}: ${d.body}`;
    case "parse":
      return `Kubo /api/v0/add returned an unparseable response: ${d.body}`;
  }
}

export type KuboAddResult = {
  cid: string;
  size: number;
};

export type KuboProbeResult =
  | { ok: true; version?: string }
  | { ok: false; kind: KuboPinErrorKind };

// Lightweight canary probe of the Kubo RPC API. Used by the setup-kubo page
// (and by onboarding) to detect whether the extension's origin is on Kubo's
// CORS allowlist before we attempt a real `add`. POST /api/v0/version takes
// no args, returns a tiny JSON object, and goes through the same Origin check
// as `add` — so a 200 here means writes will succeed too.
export async function probeKuboApi(): Promise<KuboProbeResult> {
  let resp: Response;
  try {
    resp = await fetch(`${KUBO_API_BASE}/api/v0/version`, { method: "POST" });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    if (/cors|origin/i.test(cause)) {
      return { ok: false, kind: { kind: "cors", cause } };
    }
    return { ok: false, kind: { kind: "unreachable", cause } };
  }
  if (resp.ok) {
    let version: string | undefined;
    try {
      const data = await resp.json();
      if (typeof data?.Version === "string") version = data.Version;
    } catch {
      /* ignore parse failures — a 200 from /version is enough */
    }
    return { ok: true, version };
  }
  if (resp.status === 403 || resp.status === 405) {
    const body = await resp.text().catch(() => "");
    return {
      ok: false,
      kind: { kind: "cors", cause: body || `HTTP ${resp.status}` },
    };
  }
  const body = await resp.text().catch(() => "");
  return {
    ok: false,
    kind: { kind: "http", status: resp.status, body: body.slice(0, 512) },
  };
}

export type AddOptions = {
  // MFS path under which to copy the pinned object. Allows enumeration and
  // pruning later (e.g. /dapp3/web3/<contract>/<contentHash>).
  mfsPath?: string;
};

export async function addToKubo(
  body: Uint8Array,
  opts: AddOptions = {},
): Promise<KuboAddResult> {
  const params = new URLSearchParams({
    "cid-version": "1",
    "raw-leaves": "true",
    pin: "true",
  });
  if (opts.mfsPath) params.set("to-files", opts.mfsPath);

  const form = new FormData();
  // Kubo expects the file under the field name "file". The filename doesn't
  // matter for the resulting CID (we use raw-leaves + cid v1 which hashes
  // content only), but Kubo requires *some* name in the multipart part.
  // BlobPart accepts ArrayBufferView, but TS' DOM lib narrows that to
  // Uint8Array<ArrayBuffer> (excluding SharedArrayBuffer). The cast is safe:
  // `body` is a regular Uint8Array we just created from TextEncoder.
  form.append("file", new Blob([body as BlobPart]), "body");

  const url = `${KUBO_API_BASE}/api/v0/add?${params.toString()}`;

  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", body: form });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    // Browsers conflate CORS rejection and "host is unreachable" into a
    // generic TypeError. Heuristic: if the cause mentions CORS we tag it as
    // such; otherwise it's an unreachable error.
    if (/cors|origin/i.test(cause)) {
      throw new KuboPinError({ kind: "cors", cause });
    }
    throw new KuboPinError({ kind: "unreachable", cause });
  }

  const text = await resp.text();
  if (!resp.ok) {
    if (resp.status === 403 || resp.status === 405) {
      // 403 is the typical CORS / forbidden-origin response from Kubo for
      // disallowed Origins. 405 means the API allow-methods config didn't
      // include POST. Either way the user needs to update Kubo config.
      throw new KuboPinError({ kind: "cors", cause: text || `HTTP ${resp.status}` });
    }
    throw new KuboPinError({
      kind: "http",
      status: resp.status,
      body: text.slice(0, 512),
    });
  }

  // /api/v0/add returns one JSON object per added entry, newline-delimited.
  // For a single-blob upload we get exactly one entry.
  const lastLine = text.trim().split("\n").pop() ?? "";
  let parsed: { Hash?: string; Size?: string };
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new KuboPinError({ kind: "parse", body: text.slice(0, 512) });
  }
  if (!parsed.Hash) {
    throw new KuboPinError({ kind: "parse", body: text.slice(0, 512) });
  }
  return {
    cid: parsed.Hash,
    size: Number(parsed.Size ?? body.byteLength),
  };
}

// Remove a pin and optionally clear an MFS path. Used for LRU eviction of
// stale ERC-4804 dapps — once both the pin and the MFS reference are gone,
// the bytes are eligible for Kubo's GC. We tolerate "not pinned" / "not
// found" responses because the local state may have drifted (user clobbered
// Kubo manually, GC already ran, etc.) and the eviction should still drop
// the matching cache entry from chrome.storage.
export async function unpinFromKubo(cid: string): Promise<void> {
  const url = `${KUBO_API_BASE}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`;
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST" });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new KuboPinError({ kind: "unreachable", cause });
  }
  if (resp.ok) return;
  const text = await resp.text().catch(() => "");
  // Kubo returns 500 with "not pinned or pinned indirectly" when the CID
  // isn't pinned. Non-fatal for eviction.
  if (/not pinned/i.test(text)) return;
  if (resp.status === 403 || resp.status === 405) {
    throw new KuboPinError({ kind: "cors", cause: text || `HTTP ${resp.status}` });
  }
  throw new KuboPinError({
    kind: "http",
    status: resp.status,
    body: text.slice(0, 512),
  });
}

export async function removeMfsPath(path: string): Promise<void> {
  // recursive=true so we can rm a directory; force=true so a missing path
  // doesn't error. Both are needed because the eviction caller doesn't
  // distinguish between "the entry directory" and "the entry file" — the
  // pin caller used `to-files` so the path resolves to a UnixFS file/dir
  // depending on the body shape, and we don't care which here.
  const params = new URLSearchParams({
    arg: path,
    recursive: "true",
    force: "true",
  });
  const url = `${KUBO_API_BASE}/api/v0/files/rm?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST" });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new KuboPinError({ kind: "unreachable", cause });
  }
  if (resp.ok) return;
  const text = await resp.text().catch(() => "");
  if (/file does not exist/i.test(text)) return;
  if (resp.status === 403 || resp.status === 405) {
    throw new KuboPinError({ kind: "cors", cause: text || `HTTP ${resp.status}` });
  }
  throw new KuboPinError({
    kind: "http",
    status: resp.status,
    body: text.slice(0, 512),
  });
}
