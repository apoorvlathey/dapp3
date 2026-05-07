const KUBO_GATEWAY_HOST = "localhost";
const KUBO_GATEWAY_PORT = 8080;

import type { ResolveKind } from "./messaging";

export function buildSubdomainUrl(
  kind: ResolveKind,
  value: string,
  path = "/",
  search = "",
  hash = "",
): string {
  // ERC-4804 (web3) content is pinned to local Kubo and served at the same
  // <cid>.ipfs.localhost subdomain as a normal IPFS contenthash — `value`
  // here is already the resulting IPFS CID. Map web3 to ipfs for URL shape.
  const subdomain = kind === "web3" ? "ipfs" : kind;
  const label = subdomain === "ipns" ? encodeIpnsLabel(value) : value;
  const base = `http://${label}.${subdomain}.${KUBO_GATEWAY_HOST}:${KUBO_GATEWAY_PORT}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}${search}${hash}`;
}

export function encodeIpnsLabel(label: string): string {
  return label.replace(/-/g, "--").replace(/\./g, "-");
}

export function isGatewayHost(host: string): boolean {
  return /\.(ipfs|ipns)\.localhost(:\d+)?$/i.test(host);
}

export function parseGatewayHost(
  host: string,
): { kind: "ipfs" | "ipns"; label: string } | null {
  const m = host.match(/^(.+)\.(ipfs|ipns)\.localhost(?::\d+)?$/i);
  if (!m || !m[1] || !m[2]) return null;
  return { kind: m[2] as "ipfs" | "ipns", label: m[1] };
}
