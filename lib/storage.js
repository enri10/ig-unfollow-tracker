// Storage layer.
//
// - IndexedDB holds the bulky data: full follower/following snapshots and the
//   (much smaller) diff results computed between snapshots.
// - chrome.storage.local holds small settings + run state, so the popup can
//   render instantly without opening IndexedDB, and background.js can persist
//   a partial-run cursor if the service worker gets killed mid-fetch.

const DB_NAME = "ig-unfollow-tracker";
const DB_VERSION = 1;
const SNAPSHOTS_STORE = "snapshots";
const DIFFS_STORE = "diffs";

const DEFAULT_SETTINGS = {
  notificationsEnabled: true,
  snapshotRetentionDays: 21,
  diffRetentionDays: 180,
  // Off by default: fetching the *following* list (for new-follows/
  // you-unfollowed/not-following-back) is a second full paginated fetch on
  // top of the followers one, roughly doubling requests per check. The core
  // "who unfollowed me" feature only ever needs the followers list, so this
  // stays opt-in.
  trackFollowing: false,
};

const DEFAULT_STATE = {
  lastCheck: null, // epoch ms of last completed check
  lastError: null, // { type, message, detail? , at }
  isCheckRunning: false,
  checkStartedAt: null,
  lastViewedDiffId: null,
  // Resumable-pagination cursor, set while a run is mid-flight so a killed
  // service worker can pick back up instead of restarting from page 1.
  partialRun: null, // { userId, username, stage: 'followers'|'following', collected: IGUser[], nextMaxId }
  // Consecutive 429s from Instagram, used to back off exponentially rather
  // than retrying at a fixed interval that might be shorter than Instagram's
  // actual cooldown. Reset to 0 on any successful check.
  rateLimitStreak: 0,
  nextRetryAt: null, // epoch ms of the next scheduled automatic retry, or null
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        const store = db.createObjectStore(SNAPSHOTS_STORE, { keyPath: "id" });
        store.createIndex("takenAt", "takenAt");
      }
      if (!db.objectStoreNames.contains(DIFFS_STORE)) {
        const store = db.createObjectStore(DIFFS_STORE, { keyPath: "id" });
        store.createIndex("generatedAt", "generatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Snapshots ----------

export async function saveSnapshot(snapshot) {
  const db = await openDb();
  await reqToPromise(tx(db, SNAPSHOTS_STORE, "readwrite").put(snapshot));
  return snapshot.id;
}

/** Most recent `n` snapshots, newest first. */
export async function getLatestSnapshots(n = 2) {
  const db = await openDb();
  const store = tx(db, SNAPSHOTS_STORE, "readonly");
  const index = store.index("takenAt");
  const results = [];
  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && results.length < n) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  return results;
}

/** Delete snapshots older than `retainDays`, keeping at least the 2 most recent regardless. */
export async function pruneOldSnapshots(retainDays) {
  const db = await openDb();
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const all = await getLatestSnapshots(Number.MAX_SAFE_INTEGER);
  const keep = new Set(all.slice(0, 2).map((s) => s.id)); // always keep newest 2
  const store = tx(db, SNAPSHOTS_STORE, "readwrite");
  for (const snap of all) {
    if (!keep.has(snap.id) && snap.takenAt < cutoff) {
      store.delete(snap.id);
    }
  }
}

// ---------- Diffs ----------

export async function saveDiffResult(diff) {
  const db = await openDb();
  await reqToPromise(tx(db, DIFFS_STORE, "readwrite").put(diff));
  return diff.id;
}

/** Diff history, newest first, optionally filtered by a username substring and limited. */
export async function getDiffHistory({ limit = 50, search = "" } = {}) {
  const db = await openDb();
  const store = tx(db, DIFFS_STORE, "readonly");
  const index = store.index("generatedAt");
  const results = [];
  const needle = search.trim().toLowerCase();

  function matches(diff) {
    if (!needle) return true;
    const all = [
      ...diff.newFollowers,
      ...diff.lostFollowers,
      ...diff.newFollowing,
      ...diff.lostFollowing,
    ];
    return all.some((u) => u.username.toLowerCase().includes(needle));
  }

  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && results.length < limit) {
        if (matches(cursor.value)) results.push(cursor.value);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  return results;
}

export async function pruneOldDiffs(retainDays) {
  const db = await openDb();
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const store = tx(db, DIFFS_STORE, "readwrite");
  const index = store.index("generatedAt");
  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(IDBKeyRange.upperBound(cutoff));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function clearAllData() {
  const db = await openDb();
  await Promise.all([
    reqToPromise(tx(db, SNAPSHOTS_STORE, "readwrite").clear()),
    reqToPromise(tx(db, DIFFS_STORE, "readwrite").clear()),
  ]);
  await chrome.storage.local.clear();
}

/** For "export data" in options: dump everything as plain objects. */
export async function exportAll() {
  const db = await openDb();
  const snapshots = await reqToPromise(tx(db, SNAPSHOTS_STORE, "readonly").getAll());
  const diffs = await reqToPromise(tx(db, DIFFS_STORE, "readonly").getAll());
  const settings = await getSettings();
  const state = await getState();
  const followingSince = await getFollowingSince();
  return { exportedAt: Date.now(), settings, state, followingSince, snapshots, diffs };
}

// ---------- chrome.storage.local: settings + run state ----------

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...DEFAULT_STATE, ...(state || {}) };
}

export async function setState(partial) {
  const current = await getState();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ state: next });
  return next;
}

export async function setLastError(error) {
  return setState({ lastError: error ? { ...error, at: Date.now() } : null });
}

export async function clearLastError() {
  return setState({ lastError: null });
}

// ---------- "Followed since" tracking (for chronological ordering) ----------
//
// Instagram doesn't expose when you followed someone, so this records the
// first time each currently-followed account was ever seen in a following
// snapshot (id -> epoch ms). Maintained by lib/scheduler.js on every check;
// used to sort the "not following back" list chronologically.

export async function getFollowingSince() {
  const { followingSince } = await chrome.storage.local.get("followingSince");
  return followingSince || {};
}

export async function setFollowingSince(map) {
  await chrome.storage.local.set({ followingSince: map });
}
