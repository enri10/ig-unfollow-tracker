import * as storage from "../lib/storage.js";
import { formatDateTime, formatDate, formatRelativeDay } from "../lib/utils.js";

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
    summary.textContent = `+${diff.newFollowers.length} / -${diff.lostFollowers.length} followers · ` +
      `+${diff.newFollowing.length} / -${diff.lostFollowing.length} following`;
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

function showError(error) {
  if (!error) {
    els.errorBanner.hidden = true;
    return;
  }
  els.errorText.textContent = ERROR_MESSAGES[error.type] || error.message || FALLBACK_ERROR_MESSAGE;
  els.errorBanner.hidden = false;
}

async function loadAndRender() {
  const [settings, state, [latestDiff], historyDiffs] = await Promise.all([
    storage.getSettings(),
    storage.getState(),
    storage.getDiffHistory({ limit: 1 }),
    storage.getDiffHistory({ limit: 50 }),
  ]);

  els.setupNotice.hidden = Boolean(settings.username);
  showError(state.lastError);
  els.lastCheckText.textContent = `Last check: ${formatDateTime(state.lastCheck)}`;
  els.checkNowBtn.disabled = Boolean(state.isCheckRunning);
  els.checkNowBtn.textContent = state.isCheckRunning ? "Checking…" : "Check now";

  els.followerCount.textContent = latestDiff ? latestDiff.followerCount : "–";
  els.followingCount.textContent = latestDiff ? latestDiff.followingCount : "–";

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
