import { setupAddressField } from "@/lib/url-field";

const params = new URLSearchParams(location.search);
const ensName = params.get("name") ?? "";
const reason = params.get("error") ?? "Unknown error";
const navPath = params.get("path") ?? "/";
const navSearch = params.get("search") ?? "";
const navHash = params.get("hash") ?? "";
const ADDRESS_RE = /^0x[a-f0-9]{40}$/i;

const reasonEl = document.getElementById("reason") as HTMLPreElement;
const inputEl = document.getElementById("urlinput") as HTMLDivElement;

reasonEl.textContent = reason;

const ensHistoryEl = document.getElementById(
  "ensHistory",
) as HTMLAnchorElement;
if (ensName && /^(?:[a-z0-9-]+\.)+eth$/.test(ensName)) {
  ensHistoryEl.href = `https://ens.eth.sh/history/${ensName}`;
  ensHistoryEl.hidden = false;
}
document.title = ensName
  ? `${ensName} · resolution failed`
  : "dapp3.eth · resolution failed";

type HostedFallback = {
  url: string;
  gateway: "eth-limo" | "gwei-domains" | "w3eth";
  label: string;
  description?: string;
};

// Build the public-gateway fallback URL mechanically. ENS names go to eth.limo,
// Gwei names go to gwei.domains, and raw ERC-4804 contract addresses go to
// w3eth.io.
function buildHostedFallback(): HostedFallback | null {
  const path = navPath.startsWith("/") ? navPath : `/${navPath}`;
  const tail = `${path}${navSearch}${navHash}`;
  if (ADDRESS_RE.test(ensName)) {
    return {
      url: `https://${ensName.toLowerCase()}.w3eth.io${tail}`,
      gateway: "w3eth",
      label: "Open on w3eth.io →",
      description:
        "Open this contract on the public w3eth.io gateway instead. The content is fetched without local trust-minimized verification.",
    };
  }
  if (/^(?:[a-z0-9-]+\.)+eth$/.test(ensName)) {
    return {
      url: `https://${ensName}.limo${tail}`,
      gateway: "eth-limo",
      label: "Open on eth.limo →",
    };
  }
  if (/^(?:[a-z0-9-]+\.)+gwei$/.test(ensName)) {
    return {
      url: `https://${ensName}.domains${tail}`,
      gateway: "gwei-domains",
      label: "Open on gwei.domains →",
      description:
        "Open this name on the public gwei.domains gateway instead. The content is fetched without local trust-minimized verification.",
    };
  }
  return null;
}

const fallbackEl = document.getElementById("fallback") as HTMLDivElement;
const fallbackDesc = fallbackEl.querySelector(".fallback-desc") as HTMLSpanElement;
const fallbackLink = document.getElementById(
  "ethlimo-link",
) as HTMLAnchorElement;
const fallback = buildHostedFallback();
if (fallback) {
  const fallbackUrl = fallback.url;
  fallbackLink.href = fallbackUrl;
  fallbackLink.textContent = fallback.label;
  if (fallback.description) {
    fallbackDesc.textContent = fallback.description;
  }
  fallbackEl.hidden = false;
  // Route through the SW so it installs the per-tab ALLOW override *before*
  // the navigation fires. Without it, the gateway DNR rule (if interception
  // is on) would yank the request straight back into our resolver — which is
  // exactly what the user is trying to bail out of.
  fallbackLink.addEventListener("click", (e) => {
    e.preventDefault();
    const type =
      fallback.gateway === "w3eth"
        ? "open-on-w3eth"
        : fallback.gateway === "gwei-domains"
          ? "open-on-gwei-domains"
          : "open-on-eth-limo";
    chrome.runtime
      .sendMessage({
        type,
        url: fallbackUrl,
      })
      .catch(() => {
        location.assign(fallbackUrl);
      });
  });
}

// Mirror the banner's parser: any `.eth` / `.gwei` name (incl. subdomains), preserves path/query/hash.
function parseEthInput(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "");
  if (!trimmed) return null;
  const m = trimmed.match(/^([^\/\?#]+)(.*)$/);
  if (!m || !m[1]) return null;
  const host = m[1].toLowerCase();
  const rest = m[2] || "/";
  if (!/^(?:[a-z0-9-]+\.)+(?:eth|gwei)$/.test(host)) return null;
  const suffix =
    rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")
      ? rest
      : `/${rest}`;
  return `http://${host}${suffix}`;
}

const field = setupAddressField(inputEl, {
  placeholder: "name.eth or name.gwei",
  onSubmit: (text) => {
    const url = parseEthInput(text);
    if (!url) {
      field.shake();
      return;
    }
    location.assign(url);
  },
  onEscape: () => {
    field.setValue(ensName);
    inputEl.blur();
  },
});

field.setValue(ensName);

document.getElementById("retry")?.addEventListener("click", () => {
  const url = parseEthInput(field.getValue());
  if (!url) {
    field.shake();
    return;
  }
  location.assign(url);
});

document.getElementById("settings")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
