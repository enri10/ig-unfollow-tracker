// Orchestrates a full check: alarm setup + the resumable fetch-snapshot-diff
// run. Lives separately from background.js so the actual logic is testable
// / callable from the service worker's DevTools console during manual dry
// runs (see the plan's verification steps).

import * as api from "./instagramApi.js";
import * as storage from "./storage.js";
import { computeDiff, sortNotFollowingBackChronologically } from "./diff.js";
import { todayId, randomDelay, MIN_CHECK_INTERVAL_MINUTES } from "./utils.js";

/**
 * Update the persisted "first seen following" map from the latest following
 * list: record `now` for any newly-followed account, and drop accounts no
 * longer followed (so a later re-follow gets a fresh "since" rather than
 * reusing a stale one). Returns the updated map.
 */
async function updateFollowingSince(following, now) {
  const map = await storage.getFollowingSince();
  const currentIds = new Set(following.map((u) => u.id));
  let changed = false;

  for (const u of following) {
    if (!(u.id in map)) {
      map[u.id] = now;
      changed = true;
    }
  }
  for (const id of Object.keys(map)) {
    if (!currentIds.has(id)) {
      delete map[id];
      changed = true;
    }
  }

  if (changed) await storage.setFollowingSince(map);
  return map;
}

export const DAILY_ALARM = "dailyCheck";
export const RESUME_ALARM = "resumeCheck";

export async function ensureDailyAlarm() {
  const existing = await chrome.alarms.get(DAILY_ALARM);
  if (!existing) {
    chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 1440, delayInMinutes: 1 });
  }
}

/** A stale isCheckRunning flag (e.g. from a killed service worker) shouldn't block runs forever. */
function isRunStale(state) {
  if (!state.isCheckRunning) return false;
  const startedAt = state.checkStartedAt || 0;
  return Date.now() - startedAt > 10 * 60 * 1000; // 10 minutes
}

/**
 * Fetch a full followers/following list, checkpointing progress to
 * chrome.storage.local after every page so a killed MV3 service worker can
 * resume instead of restarting from page 1.
 */
async function fetchListResumable({
  userId,
  username,
  stage,
  collected,
  nextMaxId,
  completedFollowers,
  reportedFollowerCount,
  reportedFollowingCount,
}) {
  return api.fetchFriendshipList(userId, stage, {
    resumeCollected: collected,
    resumeMaxId: nextMaxId,
    onCheckpoint: async (collectedSoFar, cursor) => {
      if (cursor) {
        await storage.setState({
          partialRun: {
            userId,
            username,
            stage,
            collected: collectedSoFar,
            nextMaxId: cursor,
            completedFollowers,
            reportedFollowerCount,
            reportedFollowingCount,
          },
        });
      }
    },
  });
}

/**
 * Run (or resume) a full followers+following check. Safe to call from the
 * daily alarm, a resume alarm, or a manual "Check Now" click.
 */
export async function performCheck({ manual = false } = {}) {
  const state = await storage.getState();

  if (state.isCheckRunning && !isRunStale(state)) {
    return { skipped: true, reason: "already-running" };
  }

  // Hard floor on starting a *new* check, regardless of trigger — this is
  // what actually stops repeated manual "Check now" clicks from looking like
  // automated abuse to Instagram, not just a suggestion in the UI. Doesn't
  // apply when we're only resuming a check already in flight (a partial
  // run) — finishing existing traffic isn't the same as starting more of it.
  if (!state.partialRun) {
    const minGapMs = MIN_CHECK_INTERVAL_MINUTES * 60 * 1000;
    const sinceLast = state.lastCheck ? Date.now() - state.lastCheck : Infinity;
    if (sinceLast < minGapMs) {
      return { skipped: true, reason: "too-soon", nextAllowedAt: state.lastCheck + minGapMs };
    }
  }

  await storage.setState({ isCheckRunning: true, checkStartedAt: Date.now() });
  await storage.clearLastError();

  try {
    const loggedIn = await api.isLoggedIn();
    if (!loggedIn) {
      throw new api.InstagramApiError(
        "NOT_LOGGED_IN",
        "You don't appear to be logged into Instagram in this browser."
      );
    }

    const settings = await storage.getSettings();
    const partialRun = state.partialRun || null;

    let userId, username, reportedFollowerCount, reportedFollowingCount;
    if (partialRun) {
      ({ userId, username } = partialRun);
      // Older checkpoints saved before this field existed won't have it — that's fine,
      // it just means no "Instagram shows X" comparison for this one resumed run.
      reportedFollowerCount = partialRun.reportedFollowerCount ?? null;
      reportedFollowingCount = partialRun.reportedFollowingCount ?? null;
    } else {
      const profile = await api.fetchUserId(await resolveTargetUsername(settings));
      userId = profile.id;
      username = profile.username;
      // Instagram's own header count, captured once per run for comparison —
      // it can legitimately differ by a handful from the count of accounts
      // its list endpoint actually returns (restricted/flagged accounts,
      // pending removals, or a follow/unfollow landing mid-run). See README.
      reportedFollowerCount = profile.followerCount ?? null;
      reportedFollowingCount = profile.followingCount ?? null;
    }

    // --- Followers (resume mid-page if a previous run was interrupted here) ---
    let followers;
    if (partialRun && partialRun.stage === "followers") {
      followers = await fetchListResumable({
        userId,
        username,
        stage: "followers",
        collected: partialRun.collected,
        nextMaxId: partialRun.nextMaxId,
        reportedFollowerCount,
        reportedFollowingCount,
      });
    } else if (partialRun && partialRun.stage === "following") {
      // Followers were already completed in the interrupted run.
      followers = partialRun.completedFollowers;
    } else {
      followers = await fetchListResumable({
        userId,
        username,
        stage: "followers",
        collected: [],
        nextMaxId: null,
        reportedFollowerCount,
        reportedFollowingCount,
      });
    }

    await randomDelay(3000, 6000);

    // --- Following ---
    let following;
    if (partialRun && partialRun.stage === "following") {
      following = await fetchListResumable({
        userId,
        username,
        stage: "following",
        collected: partialRun.collected,
        nextMaxId: partialRun.nextMaxId,
        completedFollowers: followers,
        reportedFollowerCount,
        reportedFollowingCount,
      });
    } else {
      following = await fetchListResumable({
        userId,
        username,
        stage: "following",
        collected: [],
        nextMaxId: null,
        completedFollowers: followers,
        reportedFollowerCount,
        reportedFollowingCount,
      });
    }

    // Both lists are complete — clear the checkpoint.
    await storage.setState({ partialRun: null });

    const snapshot = {
      id: todayId(),
      takenAt: Date.now(),
      userId,
      username,
      followerCount: followers.length,
      followingCount: following.length,
      // Instagram's own displayed counts at the time we started this check —
      // kept separately since they can legitimately differ from the actual
      // enumerated list length above (see the comment where these are read).
      reportedFollowerCount,
      reportedFollowingCount,
      followers,
      following,
    };

    const [prevSnapshot] = await storage.getLatestSnapshots(1);
    const comparisonSnapshot = prevSnapshot && prevSnapshot.id !== snapshot.id ? prevSnapshot : null;
    await storage.saveSnapshot(snapshot);

    const followingSinceMap = await updateFollowingSince(following, snapshot.takenAt);

    const diff = computeDiff(comparisonSnapshot, snapshot, settings);
    diff.notFollowingBack = sortNotFollowingBackChronologically(diff.notFollowingBack, followingSinceMap);
    await storage.saveDiffResult(diff);

    await storage.pruneOldSnapshots(settings.snapshotRetentionDays);
    await storage.pruneOldDiffs(settings.diffRetentionDays);

    await storage.setState({
      isCheckRunning: false,
      checkStartedAt: null,
      lastCheck: Date.now(),
      // A successful check means Instagram isn't (or is no longer) throttling
      // this session — clear any backoff state left over from earlier 429s.
      rateLimitStreak: 0,
      nextRetryAt: null,
    });

    await notifyIfNeeded(diff, settings);
    await updateBadge(diff);

    return { skipped: false, diff };
  } catch (err) {
    const errorPayload =
      err instanceof api.InstagramApiError
        ? { type: err.type, message: err.message }
        : { type: "UNKNOWN_ERROR", message: err.message || String(err) };

    await storage.setLastError(errorPayload);
    await storage.setState({ isCheckRunning: false, checkStartedAt: null });

    // Rate limits / transient failures: keep any partial-run checkpoint so
    // the next scheduled/manual run resumes rather than restarting. Only a
    // resumable-pagination error leaves partialRun set at this point; a
    // failure before pagination even started leaves it null already.
    if (errorPayload.type === "RATE_LIMITED") {
      // Back off exponentially rather than always retrying after a fixed 15
      // minutes: a 429 means Instagram is actively throttling this session,
      // and retrying (whether automatically or via repeated manual "Check
      // now" clicks) before that cools down just extends the block — in the
      // worst case escalating to a checkpoint/verification challenge on the
      // account. Consecutive 429s push the wait out further; any successful
      // check resets the streak above.
      const state = await storage.getState();
      const streak = (state.rateLimitStreak || 0) + 1;
      const backoffSchedule = [15, 30, 60, 120, 240]; // minutes
      const delayMinutes = backoffSchedule[Math.min(streak - 1, backoffSchedule.length - 1)];
      const nextRetryAt = Date.now() + delayMinutes * 60 * 1000;

      await storage.setState({ rateLimitStreak: streak, nextRetryAt });
      chrome.alarms.create(RESUME_ALARM, { delayInMinutes: delayMinutes });
    }

    return { skipped: false, error: errorPayload };
  }
}

/** The username being tracked is the currently-logged-in account's own profile. */
async function resolveTargetUsername(settings) {
  if (settings.username) return settings.username;
  throw new Error(
    "No Instagram username configured. Set your username in the extension's options page."
  );
}

async function notifyIfNeeded(diff, settings) {
  if (!settings.notificationsEnabled) return;
  if (diff.lostFollowers.length === 0) return;
  const names = diff.lostFollowers.slice(0, 3).map((u) => `@${u.username}`).join(", ");
  const extra = diff.lostFollowers.length > 3 ? ` and ${diff.lostFollowers.length - 3} more` : "";
  chrome.notifications.create(`unfollow-${diff.id}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: diff.lostFollowers.length === 1 ? "Someone unfollowed you" : `${diff.lostFollowers.length} people unfollowed you`,
    message: `${names}${extra}`,
  });
}

async function updateBadge(diff) {
  const count = diff.lostFollowers.length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#e1306c" });
}

/** Called when the user views the "Unfollowed You" tab, to clear the badge. */
export async function markLatestDiffViewed(diffId) {
  await storage.setState({ lastViewedDiffId: diffId });
  await chrome.action.setBadgeText({ text: "" });
}
