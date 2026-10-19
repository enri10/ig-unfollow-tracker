// Import from Instagram's own "Export your information" download.
//
// Why this exists: reading the followers list live goes through Instagram's
// private API, and that got the account rate-limited for weeks. The official
// data export needs no requests to Instagram at all — no risk to the account,
// no rate limit — so this is the dependable way to see who unfollowed you and
// who doesn't follow you back. The trade-off is that it's manual (you request
// the export, Instagram prepares it, you drop the file here).
//
// Everything in this file except `runImport` is pure (no chrome.*, no
// IndexedDB) so it can be unit-tested in plain Node.

import * as storage from "./storage.js";
import { computeDiff, sortNotFollowingBackChronologically } from "./diff.js";
import { todayId } from "./utils.js";

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
// Anchored to the profile host so help.instagram.com/… or other sites' links can't be mistaken for handles.
const HREF_USER_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)\/?(?:[?#]|$)/i;
// Paths on instagram.com that are never a profile, in case an HTML export has footer links.
const NOT_A_PROFILE = new Set(["p", "reel", "reels", "explore", "accounts", "stories", "direct", "about", "legal"]);

// ---------- file classification ----------

const baseName = (name) => String(name).replace(/\\/g, "/").split("/").pop().toLowerCase();

/** 'followers' | 'following' | null — only the files that matter, never e.g. following_hashtags.json. */
export function classifyExportFile(name) {
  const base = baseName(name);
  if (/^followers(_\d+)?\.(json|html)$/.test(base)) return "followers";
  if (/^following\.(json|html)$/.test(base)) return "following";
  return null;
}

// ---------- parsing ----------

function usernameFromHref(href) {
  const m = String(href || "").match(HREF_USER_RE);
  return m && !NOT_A_PROFILE.has(m[1].toLowerCase()) ? m[1] : "";
}

function pickUsername(...candidates) {
  return candidates.find((c) => typeof c === "string" && USERNAME_RE.test(c)) || "";
}

/** The list of entries in a parsed export JSON, whatever the wrapper object is called. */
function entriesOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    // followers_1.json is a bare array; following.json wraps it ({"relationships_following": [...]}).
    for (const value of Object.values(data)) if (Array.isArray(value)) return value;
  }
  return [];
}

function parseJsonUsers(text, fileName) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError(`"${fileName}" isn't valid JSON. Request the export again and choose the JSON format (not HTML).`);
  }
  const users = [];
  for (const entry of entriesOf(data)) {
    const sd = Array.isArray(entry?.string_list_data) ? entry.string_list_data[0] : null;
    // followers_1.json carries the handle in `value`; following.json carries it in `title`.
    const username = pickUsername(sd?.value, usernameFromHref(sd?.href), entry?.title);
    if (!username) continue;
    const ts = Number(sd?.timestamp);
    users.push({ username, followedAt: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null });
  }
  return users;
}

function parseHtmlUsers(text) {
  const users = [];
  const re = /href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(text))) {
    const username = usernameFromHref(m[1]);
    if (username) users.push({ username, followedAt: null }); // HTML exports carry only a locale-formatted date; not parsed
  }
  return users;
}

function toUser(raw) {
  return {
    id: `u:${raw.username.toLowerCase()}`, // exports contain no numeric ids; may be swapped for a known one in reconcileIds
    username: raw.username,
    fullName: "",
    profilePicUrl: null,
    isPrivate: false,
    followedAt: raw.followedAt,
  };
}

function dedupe(users) {
  const seen = new Set();
  const out = [];
  for (const u of users) {
    const key = u.username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toUser(u));
  }
  return out;
}

/**
 * @param {{name: string, text: string}[]} entries - candidate files (zip contents and/or loose files)
 * @returns {{followers: object[], following: object[], files: string[], notes: string[]}}
 */
export function parseInstagramExport(entries) {
  const followers = [];
  const following = [];
  const files = [];

  for (const { name, text } of entries) {
    const kind = classifyExportFile(name);
    if (!kind) continue;
    files.push(baseName(name));
    const users = baseName(name).endsWith(".html") ? parseHtmlUsers(text) : parseJsonUsers(text, baseName(name));
    (kind === "followers" ? followers : following).push(...users);
  }

  if (followers.length === 0) {
    throw new ImportError(
      files.length === 0
        ? "Couldn't find followers_1.json (or following.json) in what you selected. In Instagram's export, choose only “Followers and following” and the JSON format, then drop the downloaded .zip here."
        : "Found the files but no followers in them — is this the right export? It should contain followers_1.json."
    );
  }

  const notes = [];
  if (files.some((f) => f.endsWith(".html"))) {
    notes.push("HTML export detected: it works, but “following since” dates aren't available. Choose JSON next time for those.");
  }
  if (following.length === 0) {
    notes.push("No following.json found, so “Not following back” can't be calculated. Include it (or the whole .zip).");
  }

  return { followers: dedupe(followers), following: dedupe(following), files, notes };
}

// ---------- zip reading (no dependencies; reads only the entries it needs) ----------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

async function inflateRaw(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).arrayBuffer();
}

/**
 * Read the named entries out of a zip Blob/File, touching only the central
 * directory and the wanted entries — a full Instagram export can be gigabytes,
 * so the archive is never loaded whole.
 * @param {Blob} blob
 * @param {(name: string) => boolean} wanted
 * @returns {Promise<{name: string, text: string}[]>}
 */
export async function readZipEntries(blob, wanted) {
  const tailSize = Math.min(blob.size, 22 + 0xffff);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError("That doesn't look like a valid .zip file.");

  const entryCount = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ImportError(
      "This zip is too large for the built-in reader (ZIP64). Export only “Followers and following” to keep it small, or unzip it and drop followers_1.json and following.json."
    );
  }

  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const decoder = new TextDecoder();
  const results = [];
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === SIG_CENTRAL) {
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!wanted(name)) continue;
    if (flags & 1) throw new ImportError("This zip is password-protected; Instagram's export isn't. Is it the right file?");
    if (size > MAX_ENTRY_BYTES) throw new ImportError(`"${name}" is unexpectedly large; refusing to load it.`);

    const local = new DataView(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
    if (local.getUint32(0, true) !== SIG_LOCAL) throw new ImportError("The zip file looks damaged.");
    const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const raw = blob.slice(dataStart, dataStart + compSize);

    let bytes;
    if (method === 0) bytes = await raw.arrayBuffer();
    else if (method === 8) bytes = await inflateRaw(raw);
    else throw new ImportError(`"${name}" uses an unsupported zip compression (method ${method}).`);
    results.push({ name, text: decoder.decode(bytes) });
  }
  return results;
}

/**
 * Turn whatever the user dropped (a .zip, or loose .json/.html files) into
 * {name, text} entries for parseInstagramExport.
 * @param {File[]} files
 */
export async function readInputFiles(files) {
  const entries = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      entries.push(...(await readZipEntries(file, (n) => classifyExportFile(n) !== null)));
    } else if (classifyExportFile(file.name)) {
      entries.push({ name: file.name, text: await file.text() });
    }
  }
  return entries;
}

// ---------- snapshot + diff (the only part that touches storage) ----------

/**
 * Give imported users the numeric ids / names / pictures we already know from
 * an earlier live snapshot, matched by username. The export has no ids, so
 * without this a diff against that snapshot would call everyone new + gone.
 * (An account renamed since then shows as one removal + one addition; the
 * export gives no way to tell.)
 */
export function reconcileIds(users, prevSnapshot) {
  if (!prevSnapshot) return users;
  const known = new Map();
  for (const u of [...(prevSnapshot.following || []), ...(prevSnapshot.followers || [])]) {
    known.set(u.username.toLowerCase(), u);
  }
  return users.map((u) => {
    const k = known.get(u.username.toLowerCase());
    return k ? { ...u, id: k.id, fullName: k.fullName || "", profilePicUrl: k.profilePicUrl || null, isPrivate: Boolean(k.isPrivate) } : u;
  });
}

/**
 * Parse an export, compare it with the last snapshot from an earlier day, and
 * store the result exactly like a live check would — so the popup and History
 * need no special cases beyond `source: "import"`.
 */
export async function runImport(entries, { now = Date.now() } = {}) {
  const parsed = parseInstagramExport(entries);
  const settings = await storage.getSettings();

  const id = todayId(new Date(now));
  const recent = await storage.getLatestSnapshots(2);
  const prev = recent.find((s) => s.id !== id) || null; // same-day re-import replaces today's, so never diff against it

  const followers = reconcileIds(parsed.followers, prev);
  const following = reconcileIds(parsed.following, prev);

  const snapshot = {
    id,
    takenAt: now,
    userId: prev?.userId ?? "",
    username: settings.username || prev?.username || "",
    followerCount: followers.length,
    followingCount: following.length,
    reportedFollowerCount: null,
    reportedFollowingCount: null,
    followers,
    following,
    source: "import",
  };

  // A live snapshot taken with following-tracking off has no following list;
  // diffing against its empty one would report all 700+ follows as "new".
  const base = prev ? { ...prev, following: prev.following?.length ? prev.following : following } : null;
  const diff = computeDiff(base, snapshot, { trackFollowing: true });
  if (!prev) {
    // First snapshot ever: nothing to compare with, so "everyone is new" would just be noise.
    diff.newFollowers = [];
    diff.newFollowing = [];
  }

  // Real "following since" dates straight from the export (when present).
  const existingSince = await storage.getFollowingSince();
  const since = {};
  for (const u of following) since[u.id] = u.followedAt ?? existingSince[u.id] ?? now;
  diff.notFollowingBack = sortNotFollowingBackChronologically(diff.notFollowingBack, since);

  diff.source = "import";
  diff.generatedAt = now;
  diff.baselineSnapshotId = prev?.id ?? null;
  diff.baselineTakenAt = prev?.takenAt ?? null;

  await storage.saveSnapshot(snapshot);
  await storage.saveDiffResult(diff);
  await storage.setFollowingSince(since);
  await storage.pruneOldSnapshots(settings.snapshotRetentionDays);
  await storage.pruneOldDiffs(settings.diffRetentionDays);
  await storage.logAttempt({ outcome: "success", source: "import", manual: true, lostFollowerCount: diff.lostFollowers.length });

  return { diff, notes: parsed.notes, files: parsed.files, hadBaseline: Boolean(prev) };
}
