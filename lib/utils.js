// Small shared helpers used across background/popup/options.

/**
 * Hard floor on how often a *new* check can start, regardless of trigger
 * (manual "Check now" clicks included) — not just a suggestion. Repeated
 * checks in a short window is exactly the pattern Instagram's automated-
 * behavior detection looks for; this is enforced in lib/scheduler.js
 * (performCheck refuses to start a fresh check inside this window) and
 * mirrored here so the popup can show/disable accordingly. Does not affect
 * finishing a check that's already mid-flight (a resumed partial run).
 */
export const MIN_CHECK_INTERVAL_MINUTES = 30;

/**
 * How long a half-finished fetch (a "partial run" checkpoint) stays resumable
 * without making any progress. The checkpoint is rewritten after every page,
 * so this measures time since the last page, not since the run began.
 *
 * Resuming splices the pages already collected onto fresh pages fetched from
 * the saved cursor. That's fine minutes later (a service worker that got
 * killed) or after the short rate-limit backoffs (15/30 min), but after days
 * it silently mixes an old half-list with a new half-list, which produces
 * wrong "unfollowed you" results — and an unexpired checkpoint also bypassed
 * the check cooldown forever. 2h comfortably covers every automatic resume.
 */
export const PARTIAL_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** True if `partialRun` exists and made progress recently enough to resume. */
export function isPartialRunFresh(partialRun, now = Date.now()) {
  // Checkpoints saved before `savedAt` existed have no timestamp: treat as stale.
  return Boolean(partialRun && typeof partialRun.savedAt === "number" && now - partialRun.savedAt <= PARTIAL_RUN_MAX_AGE_MS);
}

/** Resolve after ms milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random delay between minMs and maxMs, inclusive-ish. Used to pace requests to Instagram. */
export function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

/** YYYY-MM-DD in the user's local timezone, used as a human-scannable snapshot id. */
export function todayId(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Human-readable relative-ish timestamp for the popup, e.g. "Aug 17, 2026, 14:03". */
export function formatDateTime(epochMs) {
  if (!epochMs) return "never";
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Date-only, no time, e.g. "Aug 17, 2026" — used for the "following since" captions. */
export function formatDate(epochMs) {
  if (!epochMs) return null;
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "Yesterday" / "3 days ago" / falls back to formatDate for anything older. Used in History. */
export function formatRelativeDay(epochMs) {
  if (!epochMs) return "";
  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dayDiff = Math.round((startOfDay(Date.now()) - startOfDay(epochMs)) / 86400000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} days ago`;
  return formatDate(epochMs);
}

/** Time-only, no date, e.g. "2:15 PM" — used to show when the check cooldown lifts. */
export function formatTime(epochMs) {
  if (!epochMs) return "";
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Clamp helper. */
export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------- Username validation ----------
//
// Instagram usernames: 1-30 chars, letters/digits/periods/underscores only,
// and no leading/trailing or doubled period (Instagram itself rejects those
// at signup). Validating here — rather than just trusting whatever's typed
// into Settings — means a stray leading "@", pasted profile URL, or typo
// fails fast in the options UI instead of turning into a confusing
// UNEXPECTED_RESPONSE/NOT_LOGGED_IN error from the API weeks later.
const USERNAME_PATTERN = /^[a-zA-Z0-9._]{1,30}$/;

/**
 * Strip common copy-paste noise from a username before validating it: a
 * leading "@", surrounding whitespace, and (if a full profile URL was
 * pasted) everything but the path segment.
 */
export function sanitizeUsername(input) {
  let value = String(input ?? "").trim();
  const urlMatch = value.match(/instagram\.com\/([^/?#]+)/i);
  if (urlMatch) value = urlMatch[1];
  return value.replace(/^@+/, "").trim();
}

/** True if `username` (already sanitized) is a syntactically valid Instagram handle. */
export function isValidUsername(username) {
  if (!username) return false;
  if (!USERNAME_PATTERN.test(username)) return false;
  if (username.startsWith(".") || username.endsWith(".")) return false;
  if (username.includes("..")) return false;
  return true;
}

// ---------- Retention clamping ----------
//
// Mirrors the min/max already declared on the <input type="number"> fields
// in options.html, enforced in code too since a browser doesn't stop a
// hand-edited value (devtools, or a future non-UI caller) from going
// out-of-range or non-numeric before it reaches storage.
export const SNAPSHOT_RETENTION_MIN_DAYS = 2;
export const SNAPSHOT_RETENTION_MAX_DAYS = 90;
export const SNAPSHOT_RETENTION_DEFAULT_DAYS = 21;

export const DIFF_RETENTION_MIN_DAYS = 7;
export const DIFF_RETENTION_MAX_DAYS = 730;
export const DIFF_RETENTION_DEFAULT_DAYS = 180;

/** Round, clamp, and fall back to `fallback` for anything non-numeric. */
function clampRetentionDays(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), min, max);
}

export function clampSnapshotRetentionDays(value) {
  return clampRetentionDays(
    value,
    SNAPSHOT_RETENTION_MIN_DAYS,
    SNAPSHOT_RETENTION_MAX_DAYS,
    SNAPSHOT_RETENTION_DEFAULT_DAYS
  );
}

export function clampDiffRetentionDays(value) {
  return clampRetentionDays(value, DIFF_RETENTION_MIN_DAYS, DIFF_RETENTION_MAX_DAYS, DIFF_RETENTION_DEFAULT_DAYS);
}
