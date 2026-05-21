import type { ResolveKind } from "./messaging";

export type IpfsGatewayConfig = {
  protocol: string; // e.g., "http:" or "https:"
  host: string;     // e.g., "localhost" or "127.0.0.1"
  port: number;     // e.g., 8080 or 48080
};

const DEFAULT_GATEWAY: IpfsGatewayConfig = {
  protocol: "http:",
  host: "localhost",
  port: 8080,
};

let cachedGatewayConfig: IpfsGatewayConfig = { ...DEFAULT_GATEWAY };

export function getIpfsGatewayConfig(): IpfsGatewayConfig {
  return cachedGatewayConfig;
}

export function setIpfsGatewayConfig(config: IpfsGatewayConfig): void {
  cachedGatewayConfig = config;
}

export function defaultGatewayConfig(): IpfsGatewayConfig {
  return { ...DEFAULT_GATEWAY };
}

export function parseGatewayUrl(url: string): IpfsGatewayConfig | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const defaultPort = u.protocol === "https:" ? 443 : 80;
    return {
      protocol: u.protocol,
      host: u.hostname,
      port: u.port ? Number(u.port) : defaultPort,
    };
  } catch {
    return null;
  }
}

export function formatGatewayUrl(config: IpfsGatewayConfig): string {
  const defaultPort = config.protocol === "https:" ? 443 : 80;
  const port = config.port === defaultPort ? "" : `:${config.port}`;
  return `${config.protocol}//${config.host}${port}`;
}

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
  const c = cachedGatewayConfig;
  const subdomain = kind === "web3" ? "ipfs" : kind;
  const label = subdomain === "ipns" ? encodeIpnsLabel(value) : value;
  const base = `${c.protocol}//${label}.${subdomain}.${c.host}:${c.port}`;
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
