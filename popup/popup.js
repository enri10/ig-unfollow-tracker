import * as storage from "../lib/storage.js";
import { formatDateTime, formatDate, formatRelativeDay, formatTime, MIN_CHECK_INTERVAL_MINUTES } from "../lib/utils.js";

const ERROR_MESSAGES = {
  NOT_LOGGED_IN: "You're not logged into Instagram in this browser. Log in at instagram.com, then try again.",
  CHALLENGE_REQUIRED: "Instagram wants additional verification. Open instagram.com, resolve the prompt, then check again.",
  RATE_LIMITED: "Instagram is rate-limiting this session. It'll automatically retry shortly — try again later.",
  NETWORK_ERROR: "Couldn't reach Instagram. Check your connection and try again.",
  UNEXPECTED_RESPONSE: "Instagram returned something unexpected. This may mean their site changed — see the extension's README.",
  // Deliberately no UNKNOWN_ERROR entry here: for that type we want the
  // actual error.message (it's usually specific and actionable, e.g. "no
  // username configured"), only falling back to a generic string if even
  // that's missing.
};

const FALLBACK_ERROR_MESSAGE = "Something went wrong.";

const els = {
  optionsBtn: document.getElementById("optionsBtn"),
  errorBanner: document.getElementById("errorBanner"),
  errorText: document.getElementById("errorText"),
  errorDismiss: document.getElementById("errorDismiss"),
  setupNotice: document.getElementById("setupNotice"),
  setupOptionsLink: document.getElementById("setupOptionsLink"),
  followerCount: document.getElementById("followerCount"),
  followingCount: document.getElementById("followingCount"),
  countMismatchNote: document.getElementById("countMismatchNote"),
  lastCheckText: document.getElementById("lastCheckText"),
  checkNowBtn: document.getElementById("checkNowBtn"),
  tabs: document.getElementById("tabs"),
  historySearch: document.getElementById("historySearch"),
  historyList: document.getElementById("historyList"),
  emptyHistory: document.getElementById("empty-history"),
};

const LIST_TABS = {
  lost: "lostFollowers",
  newFollowers: "newFollowers",
  lostFollowing: "lostFollowing",
  newFollowing: "newFollowing",
  notBack: "notFollowingBack",
};

// Tabs that only have data when settings.trackFollowing is on (see options).
// Cached across loadAndRender calls so the history search handler, which
// re-renders independently, can use the same value without refetching settings.
const FOLLOWING_ONLY_TABS = ["lostFollowing", "newFollowing", "notBack"];
let trackFollowingEnabled = false;

/**
 * @param {object} user
 * @param {string} [caption] - overrides the second line (defaults to fullName).
 *   Used e.g. by the "not following back" list to show "Following since …"
 *   instead, since that's what makes its chronological order legible.
 */
function userRow(user, caption) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.className = "user-row";
  a.href = `https://www.instagram.com/${encodeURIComponent(user.username)}/`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  const img = document.createElement("img");
  img.className = "avatar";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.src = user.profilePicUrl || "";
  img.alt = "";

  const meta = document.createElement("div");
  meta.className = "user-meta";
  const uname = document.createElement("div");
  uname.className = "username";
  uname.textContent = `@${user.username}`;
  const full = document.createElement("div");
  full.className = "full-name";
  full.textContent = caption ?? (user.fullName || "");
  meta.append(uname, full);

  a.append(img, meta);
  li.append(a);
  return li;
}

/** Caption for the "not following back" list: how long they've been followed, oldest-first. */
function followingSinceCaption(user) {
  return user.followedSince ? `Following since ${formatDate(user.followedSince)}` : user.fullName || "";
}

function renderList(tabKey, users, captionFn) {
  const listEl = document.getElementById(`list-${tabKey}`);
  const emptyEl = document.getElementById(`empty-${tabKey}`);
  listEl.innerHTML = "";
  if (!users || users.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const u of users) listEl.appendChild(userRow(u, captionFn ? captionFn(u) : undefined));
}

/** One labeled sub-list inside an expanded history day (only rendered if non-empty). */
function historyBucket(label, users) {
  if (!users || users.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "history-bucket";
  const heading = document.createElement("div");
  heading.className = "history-bucket-label";
  heading.textContent = `${label} (${users.length})`;
  const list = document.createElement("ul");
  list.className = "user-list";
  for (const u of users) list.appendChild(userRow(u));
  wrap.append(heading, list);
  return wrap;
}

function renderHistoryDetail(container, diff) {
  container.innerHTML = "";
  const buckets = [
    historyBucket("Unfollowed you", diff.lostFollowers),
    historyBucket("New followers", diff.newFollowers),
    historyBucket("You unfollowed", diff.lostFollowing),
    historyBucket("New follows", diff.newFollowing),
  ].filter(Boolean);

  if (buckets.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No changes that day.";
    container.append(p);
    return;
  }
  container.append(...buckets);
}

function renderHistory(diffs) {
  els.historyList.innerHTML = "";
  if (!diffs || diffs.length === 0) {
    els.emptyHistory.hidden = false;
    return;
  }
  els.emptyHistory.hidden = true;
  for (const diff of diffs) {
    const li = document.createElement("li");
    li.className = "history-item";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "history-header";

    const dateWrap = document.createElement("div");
    const date = document.createElement("div");
    date.className = "history-date";
    date.textContent = `${formatRelativeDay(diff.generatedAt)} — ${formatDateTime(diff.generatedAt)}`;
    const summary = document.createElement("div");
    summary.className = "history-summary";
    // Omit the following half entirely when it isn't tracked — "+0 / -0
    // following" would misleadingly read as "checked, no changes" rather
    // than "not tracked at all".
    summary.textContent = trackFollowingEnabled
      ? `+${diff.newFollowers.length} / -${diff.lostFollowers.length} followers · ` +
        `+${diff.newFollowing.length} / -${diff.lostFollowing.length} following`
      : `+${diff.newFollowers.length} / -${diff.lostFollowers.length} followers`;
    dateWrap.append(date, summary);

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "▾";

    header.append(dateWrap, chevron);

    const detail = document.createElement("div");
    detail.className = "history-detail";
    detail.hidden = true;

    header.addEventListener("click", () => {
      const expanding = detail.hidden;
      if (expanding && !detail.dataset.rendered) {
        renderHistoryDetail(detail, diff);
        detail.dataset.rendered = "true";
      }
      detail.hidden = !expanding;
      header.classList.toggle("expanded", expanding);
    });

    li.append(header, detail);
    els.historyList.appendChild(li);
  }
}

/**
 * The count shown above ("Followers"/"Following") is the number of accounts
 * this extension actually enumerated via Instagram's list endpoint — the
 * same number the diffing logic uses. Instagram's own header count on your
 * profile can legitimately be off by a handful from that (restricted or
 * flagged accounts, a pending removal, or a follow/unfollow landing mid-check
 * — see the README). This is a heads-up, not necessarily a bug in the list
 * itself: the new/lost-follower detection above is based on the enumerated
 * list either way, so it's unaffected by which number Instagram's UI shows.
 */
function renderCountMismatchNote(diff) {
  if (!diff) {
    els.countMismatchNote.hidden = true;
    return;
  }
  const notes = [];
  if (diff.reportedFollowerCount != null && diff.reportedFollowerCount !== diff.followerCount) {
    notes.push(`Instagram shows ${diff.reportedFollowerCount} followers, we counted ${diff.followerCount}`);
  }
  if (diff.reportedFollowingCount != null && diff.reportedFollowingCount !== diff.followingCount) {
    notes.push(`Instagram shows ${diff.reportedFollowingCount} following, we counted ${diff.followingCount}`);
  }
  if (notes.length === 0) {
    els.countMismatchNote.hidden = true;
    return;
  }
  els.countMismatchNote.textContent = `ℹ️ ${notes.join(" · ")} — normal Instagram drift, not a bug (see README).`;
  els.countMismatchNote.hidden = false;
}

/**
 * A 429 is Instagram itself throttling this session — not a stuck local
 * flag — so there's nothing to "reset" here that would actually help.
 * Retrying (manually or automatically) before Instagram's own cooldown
 * passes just extends the block, so we show a concrete countdown instead of
 * a vague "try again later", and the extension already backs off on its own
 * (see lib/scheduler.js) rather than hammering it.
 */
function showError(error, state) {
  if (!error) {
    els.errorBanner.hidden = true;
    return;
  }
  if (error.type === "RATE_LIMITED" && state?.nextRetryAt) {
    const when = formatDateTime(state.nextRetryAt);
    els.errorText.textContent =
      `Instagram is rate-limiting this session — this is Instagram's own cooldown, not something the extension can reset past. ` +
      `It'll retry automatically around ${when}. Clicking "Check now" before then risks extending the block, so it's best to just wait.`;
  } else {
    els.errorText.textContent = ERROR_MESSAGES[error.type] || error.message || FALLBACK_ERROR_MESSAGE;
  }
  els.errorBanner.hidden = false;
}

/**
 * Hide the tabs (and their panels) that only ever have data when
 * settings.trackFollowing is on — off by default, see options.js. Falls
 * back to the "Unfollowed you" tab if the currently-active one just got
 * hidden out from under the user (e.g. they turned the setting off while
 * "New follows" was selected).
 */
function applyFeatureVisibility(trackFollowing) {
  let activeTabHidden = false;
  for (const key of FOLLOWING_ONLY_TABS) {
    const btn = els.tabs.querySelector(`.tab[data-tab="${key}"]`);
    const panel = document.getElementById(`panel-${key}`);
    if (btn) {
      btn.hidden = !trackFollowing;
      if (!trackFollowing && btn.classList.contains("active")) activeTabHidden = true;
    }
    if (panel) panel.hidden = !trackFollowing;
  }
  if (activeTabHidden) switchTab("lost");
}

async function loadAndRender() {
  const [settings, state, [latestDiff], historyDiffs] = await Promise.all([
    storage.getSettings(),
    storage.getState(),
    storage.getDiffHistory({ limit: 1 }),
    storage.getDiffHistory({ limit: 50 }),
  ]);

  trackFollowingEnabled = Boolean(settings.trackFollowing);
  applyFeatureVisibility(trackFollowingEnabled);

  els.setupNotice.hidden = Boolean(settings.username);
  showError(state.lastError, state);
  els.lastCheckText.textContent = `Last check: ${formatDateTime(state.lastCheck)}`;

  // Minimum-gap cooldown: a hard floor, not just a suggestion, so repeated
  // clicking can't itself look like automated abuse to Instagram (see
  // lib/scheduler.js — this mirrors what it actually enforces).
  const cooldownUntil = !state.partialRun && state.lastCheck
    ? state.lastCheck + MIN_CHECK_INTERVAL_MINUTES * 60 * 1000
    : 0;
  const inCooldown = Date.now() < cooldownUntil;

  els.checkNowBtn.disabled = Boolean(state.isCheckRunning) || inCooldown;
  els.checkNowBtn.textContent = state.isCheckRunning
    ? "Checking…"
    : inCooldown
      ? `Available at ${formatTime(cooldownUntil)}`
      : "Check now";

  els.followerCount.textContent = latestDiff ? latestDiff.followerCount : "–";
  els.followingCount.textContent = latestDiff ? latestDiff.followingCount : "–";
  renderCountMismatchNote(latestDiff);

  renderList("lost", latestDiff?.lostFollowers);
  renderList("newFollowers", latestDiff?.newFollowers);
  renderList("lostFollowing", latestDiff?.lostFollowing);
  renderList("newFollowing", latestDiff?.newFollowing);
  renderList("notBack", latestDiff?.notFollowingBack, followingSinceCaption);
  renderHistory(historyDiffs);

  if (latestDiff && latestDiff.lostFollowers.length > 0 && state.lastViewedDiffId !== latestDiff.id) {
    // Badge stays lit until the user actually opens the "Unfollowed you" tab.
  }
}

async function handleCheckNow() {
  els.checkNowBtn.disabled = true;
  els.checkNowBtn.textContent = "Checking…";
  const response = await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
  if (response && response.skipped && response.reason === "already-running") {
    // A background run is already in flight; just refresh to reflect it.
  }
  await loadAndRender();
}

function switchTab(tabKey) {
  for (const btn of els.tabs.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tabKey);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === `panel-${tabKey}`);
  }
  if (tabKey === "lost") {
    storage.getDiffHistory({ limit: 1 }).then(([latest]) => {
      if (latest) {
        storage.setState({ lastViewedDiffId: latest.id });
        chrome.action.setBadgeText({ text: "" });
      }
    });
  }
}

els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) switchTab(btn.dataset.tab);
});

els.checkNowBtn.addEventListener("click", handleCheckNow);

els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.setupOptionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

els.errorDismiss.addEventListener("click", async () => {
  await storage.clearLastError();
  els.errorBanner.hidden = true;
});

els.historySearch.addEventListener("input", async (e) => {
  const diffs = await storage.getDiffHistory({ limit: 50, search: e.target.value });
  renderHistory(diffs);
});

loadAndRender();
