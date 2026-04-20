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
  // True when this navigation served the cached resolution; the SW is
  // re-resolving in the background and may push a `content-updated` message
  // if the contenthash has changed.
  fromCache?: boolean;
};

export type BannerHydrate = {
  type: "hydrate";
  tabId: number;
};

// Sent from the SW to the content script when a background re-resolve found
// a different contenthash than what was served from cache. The banner shows
// an "updated content available" notice with a button to navigate to the
// fresh gateway URL.
export type ContentUpdatedMessage = {
  type: "content-updated";
  ensName: string;
  kind: "ipfs" | "ipns";
  value: string;
  gatewayUrl: string;
};
