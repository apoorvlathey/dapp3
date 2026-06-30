export type AutoPinRecord = {
  cid: string;
  ensName: string;
  sizeBytes?: number;
  pinnedAt: number;
  lastSeenAt: number;
};

const KEY = "ipfsAutoPinRecords";
const MAX_RECORDS = 500;

type RecordMap = Record<string, AutoPinRecord>;

async function readMap(): Promise<RecordMap> {
  const raw = await chrome.storage.local.get(KEY);
  return (raw[KEY] as RecordMap | undefined) ?? {};
}

export async function getAutoPinRecord(
  cid: string,
): Promise<AutoPinRecord | null> {
  const map = await readMap();
  return map[cid] ?? null;
}

export async function rememberAutoPinRecord(
  record: Omit<AutoPinRecord, "lastSeenAt"> & { lastSeenAt?: number },
): Promise<void> {
  const now = Date.now();
  const map = await readMap();
  const prev = map[record.cid];
  map[record.cid] = {
    ...prev,
    ...record,
    cid: record.cid,
    ensName: record.ensName,
    pinnedAt: prev?.pinnedAt ?? record.pinnedAt,
    lastSeenAt: record.lastSeenAt ?? now,
  };

  const values = Object.values(map);
  if (values.length <= MAX_RECORDS) {
    await chrome.storage.local.set({ [KEY]: map });
    return;
  }

  const kept = values
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_RECORDS);
  const next: RecordMap = {};
  for (const item of kept) next[item.cid] = item;
  await chrome.storage.local.set({ [KEY]: next });
}
