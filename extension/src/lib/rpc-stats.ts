export type RpcFailureKind =
  | "http"
  | "jsonrpc"
  | "timeout"
  | "helios-verify"
  | "other";

export type RpcStats = {
  url: string;
  success: number;
  failure: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureReason?: string;
  lastFailureKind?: RpcFailureKind;
  // Most recent N latencies in ms.
  recentLatencies: number[];
};

const KEY = "rpcStats";
const MAX_LATENCIES = 20;

type StatsMap = Record<string, RpcStats>;

function blankStats(url: string): RpcStats {
  return { url, success: 0, failure: 0, recentLatencies: [] };
}

async function readMap(): Promise<StatsMap> {
  const raw = await chrome.storage.local.get(KEY);
  return (raw[KEY] as StatsMap | undefined) ?? {};
}

async function writeMap(map: StatsMap): Promise<void> {
  await chrome.storage.local.set({ [KEY]: map });
}

export async function getStats(url: string): Promise<RpcStats> {
  const map = await readMap();
  return map[url] ?? blankStats(url);
}

export async function getAllStats(): Promise<RpcStats[]> {
  const map = await readMap();
  return Object.values(map);
}

export async function recordSuccess(
  url: string,
  latencyMs: number,
): Promise<void> {
  const map = await readMap();
  const cur = map[url] ?? blankStats(url);
  cur.success += 1;
  cur.lastSuccessAt = Date.now();
  cur.recentLatencies = [...cur.recentLatencies, latencyMs].slice(
    -MAX_LATENCIES,
  );
  map[url] = cur;
  await writeMap(map);
}

export async function recordFailure(
  url: string,
  kind: RpcFailureKind,
  reason: string,
): Promise<void> {
  const map = await readMap();
  const cur = map[url] ?? blankStats(url);
  cur.failure += 1;
  cur.lastFailureAt = Date.now();
  cur.lastFailureKind = kind;
  cur.lastFailureReason = reason.slice(0, 240);
  map[url] = cur;
  await writeMap(map);
}

export async function clearStats(url: string): Promise<void> {
  const map = await readMap();
  delete map[url];
  await writeMap(map);
}

export function avgLatency(s: RpcStats): number | null {
  if (s.recentLatencies.length === 0) return null;
  const sum = s.recentLatencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / s.recentLatencies.length);
}

export function successRate(s: RpcStats): number | null {
  const total = s.success + s.failure;
  if (total === 0) return null;
  return s.success / total;
}

export function onStatsChanged(cb: (all: RpcStats[]) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    const v = (changes[KEY].newValue as StatsMap | undefined) ?? {};
    cb(Object.values(v));
  });
}

export function classifyError(err: unknown): {
  kind: RpcFailureKind;
  reason: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|AbortError/i.test(msg)) {
    return { kind: "timeout", reason: msg };
  }
  if (/HTTP request failed|Status: \d{3}|Non-200 status|Fetch/i.test(msg)) {
    return { kind: "http", reason: msg };
  }
  if (/json.?rpc|rpc error|invalid params|method not found/i.test(msg)) {
    return { kind: "jsonrpc", reason: msg };
  }
  if (/proof|verif|light ?client|helios/i.test(msg)) {
    return { kind: "helios-verify", reason: msg };
  }
  return { kind: "other", reason: msg };
}
