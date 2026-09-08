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
