// Homepage launcher. Accepts either a `.eth` name or a 0x contract address
// (with an optional path), and navigates to the corresponding URL. Both forms
// are caught by the SW's DNR rules:
//   - `<name>.eth/<path>` → http://<name>.eth/<path> (interceptEthLimo unrelated)
//   - `0x<addr>/<path>`   → https://<addr>.w3eth.io/<path> (interceptW3Eth)
//
// Going through the public `https://...w3eth.io` URL keeps us on the same
// resolve path as a typed/clicked w3eth.io link: the DNR rule rewrites it to
// the interstitial before the request leaves the browser. If the user has
// disabled `interceptW3Eth`, the home page intentionally falls back to the
// public gateway — that matches the toggle's "off = public gateway" semantics.

const form = document.getElementById("go") as HTMLFormElement;
const input = document.getElementById("target") as HTMLInputElement;
const hint = document.getElementById("hint") as HTMLParagraphElement;

type Parsed =
  | { kind: "ens"; host: string; rest: string }
  | { kind: "address"; address: string; rest: string };

function parse(rawInput: string): Parsed | null {
  const trimmed = rawInput.trim().replace(/^https?:\/\//i, "").replace(/^\/+/, "");
  if (!trimmed) return null;
  const m = trimmed.match(/^([^\/\?#]+)(.*)$/);
  if (!m || !m[1]) return null;
  const head = m[1].toLowerCase().replace(/:\d+$/, "");
  const rest = m[2] || "";
  const suffix =
    rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#") || rest === ""
      ? rest
      : `/${rest}`;
  if (/^0x[a-f0-9]{40}$/.test(head)) {
    return { kind: "address", address: head, rest: suffix };
  }
  // Pasted `0x<addr>.w3eth.io[:port]/path` — strip the gateway suffix.
  const w3 = head.match(/^(0x[a-f0-9]{40})\.w3eth\.io$/);
  if (w3 && w3[1]) {
    return { kind: "address", address: w3[1], rest: suffix };
  }
  // Pasted `<name>.eth.limo` / `<name>.eth.link` — strip the gateway suffix.
  const limo = head.match(/^((?:[a-z0-9-]+\.)+eth)\.(?:limo|link)$/);
  if (limo && limo[1]) {
    return { kind: "ens", host: limo[1], rest: suffix };
  }
  if (/^(?:[a-z0-9-]+\.)+eth$/.test(head)) {
    return { kind: "ens", host: head, rest: suffix };
  }
  return null;
}

function buildUrl(p: Parsed): string {
  const path = p.rest || "/";
  if (p.kind === "ens") {
    return `http://${p.host}${path}`;
  }
  return `https://${p.address}.w3eth.io${path}`;
}

function flashError(msg: string) {
  hint.textContent = msg;
  hint.hidden = false;
  input.classList.add("invalid");
  setTimeout(() => {
    input.classList.remove("invalid");
  }, 450);
}

function resetHint() {
  hint.textContent = "";
  hint.hidden = true;
}

input.addEventListener("input", () => {
  if (!hint.hidden) resetHint();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = parse(input.value);
  if (!parsed) {
    flashError(
      "Couldn't parse that. Try `name.eth` or a 0x… contract address.",
    );
    input.focus();
    input.select();
    return;
  }
  location.assign(buildUrl(parsed));
});

document.querySelectorAll<HTMLButtonElement>(".chip[data-target]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target ?? "";
    if (!target) return;
    input.value = target;
    const parsed = parse(target);
    if (!parsed) return;
    location.assign(buildUrl(parsed));
  });
});

input.focus();
