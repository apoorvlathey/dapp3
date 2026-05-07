export type ResolveRequest = {
  type: "resolve";
  name: string;
};

// "web3" is the ERC-4804 fallback path: the resolved address is a contract
// implementing ERC-5219 manual mode. We fetch its HTML body via Helios
// eth_call, pin it to local Kubo, and serve from <cid>.ipfs.localhost:8080.
// `value` is the resulting IPFS CID; `contractAddress` is kept so we can
// revalidate (and cache by) the contract that produced the bytes.
export type ResolveKind = "ipfs" | "ipns" | "web3";

// Tagged error codes the SW routes on. Plain string errors stay as-is for the
// generic error page; `code` is set only when the SW needs to take a specific
// branch (e.g. bouncing to the Kubo setup screen instead of the error page).
export type ResolveErrorCode = "kubo-cors-blocked";

export type ResolveResponse =
  | {
      ok: true;
      kind: ResolveKind;
      value: string;
      ensName: string;
      trustedDirectly: boolean;
      contractAddress?: `0x${string}`;
    }
  | {
      ok: false;
      error: string;
      code?: ResolveErrorCode;
    };

export type TabContext = {
  ensName: string;
  kind: ResolveKind;
  value: string;
  path: string;
  trustedDirectly: boolean;
  contractAddress?: `0x${string}`;
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
  kind: ResolveKind;
  value: string;
  gatewayUrl: string;
};
