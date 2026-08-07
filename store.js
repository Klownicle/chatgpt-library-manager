const DB_NAME = "chatgpt-library-manager";
const DB_VERSION = 2;
const INDEXER_VERSION = 2;
const ITEM_STORE = "items";
const SCAN_STORE = "scans";

let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ITEM_STORE)) {
        const items = db.createObjectStore(ITEM_STORE, { keyPath: "id" });
        items.createIndex("folderPath", "folderPath", { unique: false });
        items.createIndex("kind", "kind", { unique: false });
        items.createIndex("lastSeenAt", "lastSeenAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(SCAN_STORE)) {
        db.createObjectStore(SCAN_STORE, { keyPath: "folderPath" });
      }

      // Version 1 could falsely mark a 25-row viewport as a complete scan and
      // cached visibly shortened filenames. Discard only that local metadata.
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        request.transaction.objectStore(ITEM_STORE).clear();
        request.transaction.objectStore(SCAN_STORE).clear();
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Database transaction aborted."));
  });
}

export async function upsertScan(result) {
  await upsertItemsBatch(result.items || [], result.folderPath || "Library");
  await finalizeScan(result);
  return result.items?.length || 0;
}

export async function upsertItemsBatch(items, folderPath = "Library") {
  if (!items?.length) return 0;
  const db = await openDb();
  const readTransaction = db.transaction(ITEM_STORE, "readonly");
  const readStore = readTransaction.objectStore(ITEM_STORE);
  const existingItems = await Promise.all(items.map((item) => requestValue(readStore.get(item.id))));

  const transaction = db.transaction(ITEM_STORE, "readwrite");
  const itemStore = transaction.objectStore(ITEM_STORE);
  const now = Date.now();

  items.forEach((item, index) => {
    const existing = existingItems[index] || null;
    const { preserveSourceOrder, ...storedItem } = item;
    const suspiciousFolderDowngrade = existing?.kind === "folder"
      && item.kind === "file"
      && !item.extension
      && !item.size;
    const merged = {
      ...(existing || {}),
      ...storedItem,
      name: normalizeCachedName(item.name) || existing?.name || "",
      kind: suspiciousFolderDowngrade ? "folder" : (item.kind || existing?.kind || "file"),
      modified: preferObservedValue(item.modified, existing?.modified),
      size: preferObservedValue(item.size, existing?.size),
      extension: preferObservedValue(item.extension, existing?.extension),
      href: preferObservedValue(item.href, existing?.href),
      previewUrl: preferObservedValue(item.previewUrl, existing?.previewUrl),
      remoteToken: preferObservedValue(item.remoteToken, existing?.remoteToken),
      sourceOrder: preserveSourceOrder && Number.isFinite(existing?.sourceOrder)
        ? existing.sourceOrder
        : Number.isFinite(item.sourceOrder) ? item.sourceOrder : existing?.sourceOrder,
      folderPath: item.folderPath || folderPath,
      lastSeenAt: now
    };
    merged.signature = hashString(
      `${merged.name}|${merged.modified || ""}|${merged.size || ""}|${merged.kind}|${merged.href || ""}`
    );
    itemStore.put(merged);
  });

  await transactionDone(transaction);
  return items.length;
}

function preferObservedValue(incoming, existing) {
  return incoming === undefined || incoming === null || incoming === "" ? (existing || "") : incoming;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function finalizeScan(result) {
  const db = await openDb();
  const transaction = db.transaction(SCAN_STORE, "readwrite");
  const scanStore = transaction.objectStore(SCAN_STORE);
  const now = Date.now();

  scanStore.put({
    folderPath: result.folderPath || "Library",
    scannedAt: now,
    itemCount: result.itemCount ?? result.items?.length ?? 0,
    complete: Boolean(result.complete || result.stoppedAtKnownItem),
    stoppedAtKnownItem: Boolean(result.stoppedAtKnownItem),
    indexerVersion: INDEXER_VERSION,
    diagnostics: result.diagnostics || null
  });

  await transactionDone(transaction);
  return result;
}

export async function getAllItems() {
  const db = await openDb();
  const transaction = db.transaction(ITEM_STORE, "readonly");
  const storedItems = await requestValue(transaction.objectStore(ITEM_STORE).getAll());
  const groups = new Map();

  for (const item of storedItems) {
    const normalizedName = normalizeCachedName(item.name);
    const normalized = { ...item, name: normalizedName };
    if (isCachedUiArtifact(normalized)) continue;
    const key = `${item.folderPath}|${item.kind}|${normalizedName.toLocaleLowerCase()}`;
    const group = groups.get(key) || [];
    group.push({ item: normalized, corrected: normalizedName !== item.name });
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    if (group.length === 1 || !group.some((entry) => entry.corrected)) {
      return group.map((entry) => entry.item);
    }
    return [group
      .map((entry) => entry.item)
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))[0]];
  });
}

function normalizeCachedName(name) {
  const value = String(name || "").trim();
  if (value.length < 2 || value.length % 2 !== 0) return value;
  const midpoint = value.length / 2;
  return value.slice(0, midpoint) === value.slice(midpoint) ? value.slice(0, midpoint) : value;
}

function isCachedUiArtifact(item) {
  return item.kind === "file"
    && /^(?:filter|filters)$/i.test(item.name || "")
    && !item.modified
    && !item.size
    && !item.extension
    && !item.href;
}

export async function getAllScans() {
  const db = await openDb();
  const transaction = db.transaction(SCAN_STORE, "readonly");
  return requestValue(transaction.objectStore(SCAN_STORE).getAll());
}

export async function getKnownSignatures(folderPath) {
  const [items, scans] = await Promise.all([getAllItems(), getAllScans()]);
  const scan = scans.find((entry) => entry.folderPath === folderPath);
  if (!scan?.complete || scan.indexerVersion !== INDEXER_VERSION) return {};
  return Object.fromEntries(
    items
      .filter((item) => item.folderPath === folderPath)
      .map((item) => [item.id, item.signature])
  );
}

export async function clearCache() {
  const db = await openDb();
  const transaction = db.transaction([ITEM_STORE, SCAN_STORE], "readwrite");
  transaction.objectStore(ITEM_STORE).clear();
  transaction.objectStore(SCAN_STORE).clear();
  await transactionDone(transaction);
}

export async function clearFolderCache(folderPath) {
  const db = await openDb();
  const transaction = db.transaction([ITEM_STORE, SCAN_STORE], "readwrite");
  const itemStore = transaction.objectStore(ITEM_STORE);
  const folderIndex = itemStore.index("folderPath");
  const cursorRequest = folderIndex.openKeyCursor(IDBKeyRange.only(folderPath));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    itemStore.delete(cursor.primaryKey);
    cursor.continue();
  };
  transaction.objectStore(SCAN_STORE).delete(folderPath);
  await transactionDone(transaction);
}

export async function deleteCachedItems(items = []) {
  const candidates = items
    .filter((item) => item?.id)
    .map((item) => ({
      id: String(item.id),
      name: String(item.name || ""),
      folderPath: String(item.folderPath || ""),
      signature: String(item.signature || "")
    }));
  if (!candidates.length) return [];

  const db = await openDb();
  const transaction = db.transaction([ITEM_STORE, SCAN_STORE], "readwrite");
  const itemStore = transaction.objectStore(ITEM_STORE);
  const scanStore = transaction.objectStore(SCAN_STORE);
  const storedItems = await Promise.all(
    candidates.map((candidate) => requestValue(itemStore.get(candidate.id)))
  );
  const removed = [];

  candidates.forEach((candidate, index) => {
    const stored = storedItems[index];
    if (!stored || !matchesDeletionIdentity(stored, candidate)) return;
    itemStore.delete(stored.id);
    removed.push(stored);
  });

  const removedByFolder = new Map();
  for (const item of removed) {
    const folderPath = item.folderPath || "Library";
    removedByFolder.set(folderPath, (removedByFolder.get(folderPath) || 0) + 1);
  }

  const folderPaths = [...removedByFolder.keys()];
  const scans = await Promise.all(folderPaths.map((folderPath) => requestValue(scanStore.get(folderPath))));
  scans.forEach((scan, index) => {
    if (!scan) return;
    const removedCount = removedByFolder.get(folderPaths[index]) || 0;
    scanStore.put({
      ...scan,
      itemCount: Math.max(0, Number(scan.itemCount || 0) - removedCount),
      scannedAt: Date.now(),
      diagnostics: {
        ...(scan.diagnostics || {}),
        lastCacheMutation: "confirmed-delete",
        lastCacheMutationAt: Date.now()
      }
    });
  });

  await transactionDone(transaction);
  return removed;
}

function matchesDeletionIdentity(stored, candidate) {
  if (candidate.name && stored.name !== candidate.name) return false;
  if (candidate.folderPath && stored.folderPath !== candidate.folderPath) return false;
  return true;
}
