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
  error?: string;
};

export type HeliosResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string };
