import {
  getAllBookmarks,
  onBookmarksChanged,
  removeBookmark,
  type Bookmark,
} from "@/lib/bookmarks";

const gridEl = document.getElementById("grid") as HTMLDivElement;
const searchEl = document.getElementById("search") as HTMLInputElement;
const emptyEl = document.getElementById("empty") as HTMLDivElement;
const noMatchEl = document.getElementById("no-match") as HTMLDivElement;

let all: Bookmark[] = [];
let query = "";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayUrl(b: Bookmark): string {
  // Strip a bare "/" so the root case renders as `vitalik.eth`, not
  // `vitalik.eth/`. Any real path (including query/hash) is kept verbatim.
  const path = b.path === "/" ? "" : b.path;
  return `${b.ensName}${path}`;
}

function matches(b: Bookmark, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    displayUrl(b).toLowerCase().includes(needle) ||
    (b.title?.toLowerCase().includes(needle) ?? false) ||
    (b.description?.toLowerCase().includes(needle) ?? false)
  );
}

const FALLBACK_FAVICON_HTML = `<span class="favicon fallback" aria-hidden="true"><svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M16 4 L8 17 L16 13 L24 17 Z" fill="#10b981"/><path d="M16 28 L8 19 L16 15 L24 19 Z" fill="#059669"/></svg></span>`;

function swapToFallback(img: HTMLImageElement) {
  // outerHTML replaces the node in-place with the fallback span; attribute
  // escaping headaches (SVG strings + double-quoted onerror) are why we do
  // this in a real event handler instead of an inline onerror attribute.
  img.outerHTML = FALLBACK_FAVICON_HTML;
}

function cardHtml(b: Bookmark): string {
  const title = b.title?.trim();
  const titleHtml = title
    ? `<div class="title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>`
    : `<div class="title untitled">Untitled</div>`;

  const faviconHtml = b.favicon
    ? `<img class="favicon" src="${escapeHtml(b.favicon)}" alt="" />`
    : FALLBACK_FAVICON_HTML;

  const desc = b.description?.trim();
  const descHtml = desc ? `<div class="desc">${escapeHtml(desc)}</div>` : "";

  // DNR rewrites the outgoing `http://<name>.eth/...` main_frame request
  // through the interstitial → resolver flow, so a plain anchor href is
  // enough — no need to route through the SW.
  const path = b.path.startsWith("/") ? b.path : `/${b.path}`;
  const href = `http://${b.ensName}${path}`;
  const shown = displayUrl(b);
  // Render the ENS name bold and the path dim so the name is the visual
  // focus of the card.
  const pathSegment = b.path === "/" ? "" : b.path;
  const ensHtml = `<span class="ens-host">${escapeHtml(b.ensName)}</span>${pathSegment ? `<span class="ens-path">${escapeHtml(pathSegment)}</span>` : ""}`;

  return `
    <a class="card" href="${escapeHtml(href)}" data-ens="${escapeHtml(b.ensName)}" data-path="${escapeHtml(b.path)}">
      <button class="remove" type="button" aria-label="remove bookmark" title="Remove bookmark">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3 L13 13 M13 3 L3 13"/>
        </svg>
      </button>
      <div class="card-head">
        ${faviconHtml}
        ${titleHtml}
      </div>
      <div class="ens" title="${escapeHtml(shown)}">${ensHtml}</div>
      ${descHtml}
    </a>
  `;
}

function render() {
  const filtered = all.filter((b) => matches(b, query));

  if (all.length === 0) {
    gridEl.innerHTML = "";
    emptyEl.hidden = false;
    noMatchEl.hidden = true;
    return;
  }
  if (filtered.length === 0) {
    gridEl.innerHTML = "";
    emptyEl.hidden = true;
    noMatchEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  noMatchEl.hidden = true;
  gridEl.innerHTML = filtered.map(cardHtml).join("");

  // Wire favicon error fallback after the HTML is parsed. Two cases to cover:
  //   1) A decode/load error fires after we attach — `error` listener handles it.
  //   2) The image was cached as broken and already-errored by the time we
  //      queried the node — `complete && naturalWidth === 0` detects it.
  const imgs = gridEl.querySelectorAll<HTMLImageElement>("img.favicon");
  imgs.forEach((img) => {
    if (img.complete && img.naturalWidth === 0) {
      swapToFallback(img);
      return;
    }
    img.addEventListener("error", () => swapToFallback(img), { once: true });
  });
}

gridEl.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const removeBtn = target.closest(".remove");
  if (!removeBtn) return;
  // Suppress the parent <a> navigation.
  e.preventDefault();
  e.stopPropagation();
  const card = removeBtn.closest(".card") as HTMLElement | null;
  const ens = card?.dataset.ens;
  const path = card?.dataset.path;
  if (!ens || path == null) return;
  await removeBookmark(ens, path);
});

searchEl.addEventListener("input", () => {
  query = searchEl.value.trim();
  render();
});

onBookmarksChanged((list) => {
  all = list;
  render();
});

(async () => {
  all = await getAllBookmarks();
  render();
})();
