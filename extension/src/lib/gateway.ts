import type { ResolveKind } from "./messaging";

export const DEFAULT_IPFS_GATEWAY_HOST = "localhost";
export const DEFAULT_IPFS_GATEWAY_PORT = 8080;
export const EMPTY_UNIXFS_CID = "bafkqaaa";

export type IpfsGatewayConfig = {
  host: string;
  port: number;
};

export const DEFAULT_IPFS_GATEWAY: IpfsGatewayConfig = {
  host: DEFAULT_IPFS_GATEWAY_HOST,
  port: DEFAULT_IPFS_GATEWAY_PORT,
};

type GatewaySettingsLike = {
  ipfsGatewayHost?: unknown;
  ipfsGatewayPort?: unknown;
};

export function parseIpfsGatewayHostInput(
  raw: unknown,
): { host: string; port?: number } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let host = trimmed;
  let port: number | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:") return null;
      if (
        parsed.username ||
        parsed.password ||
        (parsed.pathname && parsed.pathname !== "/") ||
        parsed.search ||
        parsed.hash
      ) {
        return null;
      }
      host = parsed.hostname;
      const explicitPort = trimmed.match(
        /^http:\/\/[^/?#]*:(\d+)(?:\/)?$/i,
      )?.[1];
      if (explicitPort || parsed.port) {
        const parsedPort = normalizeIpfsGatewayPort(explicitPort ?? parsed.port);
        if (!parsedPort) return null;
        port = parsedPort;
      }
    } catch {
      return null;
    }
  }

  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (!normalized) return null;
  if (/[/:?#@\[\]\\]/.test(normalized)) return null;
  if (!/^[a-z0-9.-]+$/.test(normalized)) return null;
  if (normalized.startsWith(".") || normalized.endsWith(".")) return null;
  if (normalized.includes("..")) return null;
  return { host: normalized, port };
}

export function normalizeIpfsGatewayHost(raw: unknown): string | null {
  return parseIpfsGatewayHostInput(raw)?.host ?? null;
}

export function normalizeIpfsGatewayPort(raw: unknown): number | null {
  const n =
    typeof raw === "string" && raw.trim()
      ? Number(raw.trim())
      : typeof raw === "number"
        ? raw
        : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export function getIpfsGatewayConfig(
  settings?: GatewaySettingsLike | null,
): IpfsGatewayConfig {
  return {
    host:
      normalizeIpfsGatewayHost(settings?.ipfsGatewayHost) ??
      DEFAULT_IPFS_GATEWAY_HOST,
    port:
      normalizeIpfsGatewayPort(settings?.ipfsGatewayPort) ??
      DEFAULT_IPFS_GATEWAY_PORT,
  };
}

export function buildSubdomainUrl(
  kind: ResolveKind,
  value: string,
  path = "/",
  search = "",
  hash = "",
  gateway: IpfsGatewayConfig = DEFAULT_IPFS_GATEWAY,
): string {
  // ERC-4804 (web3) content is pinned to local Kubo and served at the same
  // <cid>.ipfs.<host> subdomain as a normal IPFS contenthash — `value`
  // here is already the resulting IPFS CID. Map web3 to ipfs for URL shape.
  const subdomain = kind === "web3" ? "ipfs" : kind;
  const label = subdomain === "ipns" ? encodeIpnsLabel(value) : value;
  const base = `http://${label}.${subdomain}.${gateway.host}:${gateway.port}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}${search}${hash}`;
}

export function buildIpfsGatewayProbeUrl(
  gateway: IpfsGatewayConfig = DEFAULT_IPFS_GATEWAY,
): string {
  return buildSubdomainUrl("ipfs", EMPTY_UNIXFS_CID, "/", "", "", gateway);
}

export function ipfsGatewayOriginPatterns(
  gateway: IpfsGatewayConfig,
): string[] {
  return [
    `http://*.ipfs.${gateway.host}/*`,
    `http://*.ipns.${gateway.host}/*`,
  ];
}

export function encodeIpnsLabel(label: string): string {
  return label.replace(/-/g, "--").replace(/\./g, "-");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isGatewayHost(
  host: string,
  gatewayHost: string = DEFAULT_IPFS_GATEWAY_HOST,
): boolean {
  const normalized = normalizeIpfsGatewayHost(gatewayHost);
  if (!normalized) return false;
  return new RegExp(
    `\\.(ipfs|ipns)\\.${escapeRegex(normalized)}(?::\\d+)?$`,
    "i",
  ).test(host);
}

export function parseGatewayHost(
  host: string,
  gatewayHost: string = DEFAULT_IPFS_GATEWAY_HOST,
): { kind: "ipfs" | "ipns"; label: string } | null {
  const normalized = normalizeIpfsGatewayHost(gatewayHost);
  if (!normalized) return null;
  const m = host.match(
    new RegExp(
      `^(.+)\\.(ipfs|ipns)\\.${escapeRegex(normalized)}(?::\\d+)?$`,
      "i",
    ),
  );
  if (!m || !m[1] || !m[2]) return null;
  return { kind: m[2] as "ipfs" | "ipns", label: m[1] };
}
