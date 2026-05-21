export type HeliosRequestMsg = {
  target: "offscreen";
  type: "helios-request";
  method: string;
  params: unknown[];
};

export type HeliosStatusMsg = {
  target: "offscreen";
  type: "helios-status";
};

export type HeliosBootstrapMsg = {
  target: "offscreen";
  type: "helios-bootstrap";
  config: {
    executionRpc: string;
    consensusRpc?: string;
    // Additional beacon RPCs that must byte-equal agree with the primary on
    // the finalized root before bootstrap proceeds. Empty/undefined → no
    // multi-source verification (single-source bootstrap, today's default).
    consensusVerifiers?: string[];
    checkpoint?: string;
  };
};

export type HeliosShutdownMsg = {
  target: "offscreen";
  type: "helios-shutdown";
};

export type HeliosStatus = {
  state: "idle" | "booting" | "syncing" | "synced" | "error";
  executionRpc?: string;
  consensusRpc?: string;
  error?: string;
  // Execution-RPC health, observed from real provider.request() outcomes.
  // Helios's `synced` state only reflects consensus-side sync; a green
  // `synced` here can coexist with every eth_call returning HTTP 4xx/5xx
  // because the user's primary RPC URL is misconfigured. The popup uses
  // this to avoid showing a misleading "online" indicator.
  rpcHealth?: {
    state: "ok" | "failing" | "unknown";
    lastError?: string;
    lastErrorTs?: number;
    lastSuccessTs?: number;
  };
};

export type HeliosResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string };
