import { setupAddressField } from "@/lib/url-field";

const params = new URLSearchParams(location.search);
const ensName = params.get("name") ?? "";
const reason = params.get("error") ?? "Unknown error";

const reasonEl = document.getElementById("reason") as HTMLPreElement;
const inputEl = document.getElementById("urlinput") as HTMLDivElement;

reasonEl.textContent = reason;
document.title = ensName
  ? `${ensName} · resolution failed`
  : "dapp3 · resolution failed";

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
