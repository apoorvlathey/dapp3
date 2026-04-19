export type ResolveRequest = {
  type: "resolve";
  name: string;
};

export type ResolveResponse =
  | {
      ok: true;
      kind: "ipfs" | "ipns";
      value: string;
      ensName: string;
      trustedDirectly: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type TabContext = {
  ensName: string;
  kind: "ipfs" | "ipns";
  value: string;
  path: string;
  trustedDirectly: boolean;
};

export type BannerHydrate = {
  type: "hydrate";
  tabId: number;
};
