import { setupAddressField } from "@/lib/url-field";

const params = new URLSearchParams(location.search);
const ensName = params.get("name") ?? "";
const reason = params.get("error") ?? "Unknown error";
const navPath = params.get("path") ?? "/";
const navSearch = params.get("search") ?? "";
const navHash = params.get("hash") ?? "";

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

// Build the public-gateway fallback URL mechanically: any `<name>.eth` is
// served at `<name>.eth.limo`. Skip if we don't have a usable .eth name to
// avoid offering a broken link (e.g. when the original navigation didn't pass
// through ENS resolution at all).
function buildEthLimoFallback(): string | null {
  if (!/^(?:[a-z0-9-]+\.)+eth$/.test(ensName)) return null;
  const path = navPath.startsWith("/") ? navPath : `/${navPath}`;
  return `https://${ensName}.limo${path}${navSearch}${navHash}`;
}

const fallbackEl = document.getElementById("fallback") as HTMLDivElement;
const fallbackLink = document.getElementById(
  "ethlimo-link",
) as HTMLAnchorElement;
const fallbackUrl = buildEthLimoFallback();
if (fallbackUrl) {
  fallbackLink.href = fallbackUrl;
  fallbackEl.hidden = false;
  // Route through the SW so it installs the per-tab ALLOW override *before*
  // the navigation fires. Without it, the eth.limo DNR rule (if interception
  // is on) would yank the request straight back into our resolver — which is
  // exactly what the user is trying to bail out of.
  fallbackLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime
      .sendMessage({ type: "open-on-eth-limo", url: fallbackUrl })
      .catch(() => {
        location.assign(fallbackUrl);
      });
  });
}

// Mirror the banner's parser: any `.eth` name (incl. subdomains), preserves path/query/hash.
function parseEthInput(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "");
  if (!trimmed) return null;
  const m = trimmed.match(/^([^\/\?#]+)(.*)$/);
  if (!m || !m[1]) return null;
  const host = m[1].toLowerCase();
  const rest = m[2] || "/";
  if (!/^(?:[a-z0-9-]+\.)+eth$/.test(host)) return null;
  const suffix =
    rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")
      ? rest
      : `/${rest}`;
  return `http://${host}${suffix}`;
}

const field = setupAddressField(inputEl, {
  placeholder: "name.eth",
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
