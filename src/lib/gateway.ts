const KUBO_GATEWAY_HOST = "localhost";
const KUBO_GATEWAY_PORT = 8080;

export function buildSubdomainUrl(
  kind: "ipfs" | "ipns",
  value: string,
  path = "/",
  search = "",
  hash = "",
): string {
  const label = kind === "ipns" ? encodeIpnsLabel(value) : value;
  const base = `http://${label}.${kind}.${KUBO_GATEWAY_HOST}:${KUBO_GATEWAY_PORT}`;
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
