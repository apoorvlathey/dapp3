// Persisted "favorite dapps" list, keyed by the full underlying URL
// (`<ensName><path>`), so `vitalik.eth/` and `vitalik.eth/page1` are separate
// bookmarks. Metadata (title, favicon, og:description) is scraped from the
// page DOM at the moment the user stars the page and stored verbatim — we
// don't refresh it on later visits, since the user's intent is a snapshot
// of the page as they knew it.

export type Bookmark = {
  ensName: string;
  // Starts with "/" and includes search + hash. "/" for the site root.
  path: string;
  title?: string;
  favicon?: string;
  description?: string;
  addedAt: number;
};

const KEY = "bookmarks";

type BookmarkMap = Record<string, Bookmark>;

// Normalize a path so `""`, `"/"`, and `undefined` all collapse to "/" and
// queries/hashes are preserved verbatim. Used both as the storage key suffix
// and the display path.
export function normalizePath(path: string | undefined | null): string {
  if (!path) return "/";
  if (!path.startsWith("/") && !path.startsWith("?") && !path.startsWith("#")) {
    return `/${path}`;
  }
  return path;
}

function makeKey(ensName: string, path: string): string {
  return `${ensName.toLowerCase()}${normalizePath(path)}`;
}

async function readMap(): Promise<BookmarkMap> {
  const raw = await chrome.storage.local.get(KEY);
  const map = (raw[KEY] as BookmarkMap | undefined) ?? {};
  // Entries written before `path` existed are keyed on bare ensName and
  // have no `path` field. Backfill the field and re-key them under the new
  // `ensName + path` scheme so subsequent reads/writes line up. Write the
  // normalized map back exactly once per stale read.
  let mutated = false;
  const normalized: BookmarkMap = {};
  for (const [k, entry] of Object.entries(map)) {
    const ensName = entry.ensName?.toLowerCase() ?? k.toLowerCase();
    const path = typeof entry.path === "string" ? entry.path : "/";
    const properKey = makeKey(ensName, path);
    const fixed: Bookmark = { ...entry, ensName, path };
    normalized[properKey] = fixed;
    if (k !== properKey || typeof entry.path !== "string") {
      mutated = true;
    }
  }
  if (mutated) {
    await chrome.storage.local.set({ [KEY]: normalized });
  }
  return normalized;
}

export async function getAllBookmarks(): Promise<Bookmark[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => b.addedAt - a.addedAt);
}

export async function isBookmarked(
  ensName: string,
  path: string,
): Promise<boolean> {
  const map = await readMap();
  return makeKey(ensName, path) in map;
}

export async function addBookmark(entry: Bookmark): Promise<void> {
  const normalized: Bookmark = {
    ...entry,
    ensName: entry.ensName.toLowerCase(),
    path: normalizePath(entry.path),
  };
  const map = await readMap();
  map[makeKey(normalized.ensName, normalized.path)] = normalized;
  await chrome.storage.local.set({ [KEY]: map });
}

export async function removeBookmark(
  ensName: string,
  path: string,
): Promise<void> {
  const k = makeKey(ensName, path);
  const map = await readMap();
  if (!(k in map)) return;
  delete map[k];
  await chrome.storage.local.set({ [KEY]: map });
}

export function onBookmarksChanged(cb: (list: Bookmark[]) => void) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    const map = (changes[KEY].newValue as BookmarkMap | undefined) ?? {};
    cb(Object.values(map).sort((a, b) => b.addedAt - a.addedAt));
  });
}
