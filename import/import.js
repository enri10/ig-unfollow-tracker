// Full-tab view: the complete lists (who doesn't follow you back, who unfollowed
// you, new followers) plus the importer. This is a tab rather than the popup
// because Chrome closes a popup the moment a file picker opens.

import * as storage from "../lib/storage.js";
import { runImport, readInputFiles, ImportError } from "../lib/importer.js";
import { userRow } from "../lib/ui.js";
import { formatDate, formatDateTime } from "../lib/utils.js";

const $ = (id) => document.getElementById(id);
const els = {
  summary: $("summary"), tabs: $("tabs"), filter: $("filter"), sort: $("sort"), sortWrap: $("sortWrap"),
  tabNote: $("tabNote"), list: $("list"), empty: $("empty"),
  drop: $("drop"), file: $("file"), pick: $("pick"), status: $("status"), howTo: $("howTo"),
};

const view = { diff: null, hasFollowing: false, tab: "notBack" };

const TAB_KEYS = { notBack: "notFollowingBack", lost: "lostFollowers", newFollowers: "newFollowers" };

function usersFor(tab) {
  return (view.diff && view.diff[TAB_KEYS[tab]]) || [];
}

function sortUsers(users, how) {
  const copy = [...users];
  if (how === "az") return copy.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
  // The stored order is oldest-follow-first; "newest" is just that reversed.
  return how === "newest" ? copy.reverse() : copy;
}

function renderSummary() {
  const d = view.diff;
  els.summary.textContent = "";
  if (!d) {
    els.summary.textContent = "Nothing here yet — import your Instagram data below to see who doesn't follow you back and who unfollowed you.";
    return;
  }
  const strong = (t) => Object.assign(document.createElement("strong"), { textContent: t });
  els.summary.append(
    `Data from ${formatDateTime(d.generatedAt)} · `, strong(String(d.followerCount)), " followers · ",
    strong(String(d.followingCount)), " following"
  );
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = d.source === "import" ? "from your Instagram export" : "from a live check";
  els.summary.append(pill);
}

function renderCounts() {
  for (const tab of Object.keys(TAB_KEYS)) {
    const n = tab === "notBack" && !view.hasFollowing ? "–" : String(usersFor(tab).length);
    $(`count-${tab}`).textContent = n;
  }
}

function tabNote() {
  const d = view.diff;
  const since = d?.baselineTakenAt ? formatDate(d.baselineTakenAt) : null;
  if (!d) return "";
  if (view.tab === "notBack") {
    return view.hasFollowing ? "Accounts you follow that don't follow you back." : "";
  }
  if (view.tab === "lost") {
    return since ? `People who followed you on ${since} (your previous snapshot) but don't now.` : "People who were following you in the previous snapshot but don't now.";
  }
  return since ? `People who started following you since ${since}.` : "";
}

function emptyText(filtered) {
  if (!view.diff) return "";
  if (view.tab === "notBack" && !view.hasFollowing) {
    return "No following list yet. Import your Instagram data below (it includes the accounts you follow).";
  }
  if (filtered) return "No one matches that filter.";
  if (view.tab === "notBack") return "Everyone you follow follows you back. 🎉";
  if (view.tab === "lost") return view.diff.baselineSnapshotId || view.diff.comparedSnapshotIds?.[0]
    ? "No one has unfollowed you since the previous snapshot."
    : "This is your first snapshot, so there's nothing to compare with yet. Import again later to see who unfollowed.";
  return "No new followers since the previous snapshot.";
}

function renderList() {
  const query = els.filter.value.trim().toLowerCase();
  els.sortWrap.hidden = view.tab !== "notBack";

  let users = usersFor(view.tab);
  if (view.tab === "notBack") users = sortUsers(users, els.sort.value);
  const shown = query ? users.filter((u) => u.username.toLowerCase().includes(query) || (u.fullName || "").toLowerCase().includes(query)) : users;

  els.tabNote.textContent = tabNote();
  els.list.textContent = "";
  for (const u of shown) {
    const caption = view.tab === "notBack" && u.followedSince ? `Following since ${formatDate(u.followedSince)}` : undefined;
    els.list.append(userRow(u, caption));
  }
  els.empty.textContent = shown.length === 0 ? emptyText(Boolean(query) && users.length > 0) : "";
  els.empty.hidden = shown.length > 0;
}

function selectTab(tab) {
  view.tab = tab;
  for (const btn of els.tabs.querySelectorAll(".tab")) btn.classList.toggle("active", btn.dataset.tab === tab);
  renderList();
}

export async function render() {
  const [diff] = await storage.getDiffHistory({ limit: 1 });
  const settings = await storage.getSettings();
  view.diff = diff || null;
  view.hasFollowing = Boolean(diff && (diff.source === "import" || settings.trackFollowing));
  renderSummary();
  renderCounts();
  renderList();
}

// ---------- importing ----------

function showStatus(kind, parts) {
  els.status.className = `status ${kind}`;
  els.status.textContent = "";
  for (const part of parts) {
    if (Array.isArray(part)) {
      const ul = document.createElement("ul");
      for (const item of part) ul.append(Object.assign(document.createElement("li"), { textContent: item }));
      els.status.append(ul);
    } else {
      els.status.append(Object.assign(document.createElement("div"), { textContent: part }));
    }
  }
  els.status.hidden = false;
}

export async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  showStatus("busy", ["Reading your export…"]);
  try {
    const entries = await readInputFiles(files);
    const { diff, notes, hadBaseline } = await runImport(entries);

    const lines = [
      `✓ Imported ${diff.followerCount} followers and ${diff.followingCount} following.`,
      hadBaseline
        ? `${diff.lostFollowers.length} unfollowed you, ${diff.newFollowers.length} new follower${diff.newFollowers.length === 1 ? "" : "s"}` +
          (diff.followingCount ? `, ${diff.notFollowingBack.length} don't follow you back.` : ".")
        : `First snapshot saved — import again later to see who unfollowed you. ${diff.followingCount ? `${diff.notFollowingBack.length} accounts you follow don't follow you back.` : ""}`.trim(),
    ];
    showStatus("ok", notes.length ? [...lines, notes] : lines);
    els.howTo.open = false;
    await render();
    selectTab(hadBaseline && diff.lostFollowers.length ? "lost" : diff.followingCount ? "notBack" : "lost");
  } catch (err) {
    showStatus("err", [err instanceof ImportError ? err.message : `Something went wrong reading that file: ${err.message}`]);
  }
}

els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) selectTab(btn.dataset.tab);
});
els.filter.addEventListener("input", renderList);
els.sort.addEventListener("change", renderList);

els.pick.addEventListener("click", (e) => { e.stopPropagation(); els.file.click(); });
els.drop.addEventListener("click", () => els.file.click());
els.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); } });
els.file.addEventListener("change", () => { handleFiles(els.file.files); els.file.value = ""; });
for (const type of ["dragenter", "dragover"]) els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.add("over"); });
for (const type of ["dragleave", "drop"]) els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.remove("over"); });
els.drop.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
// A file dropped *beside* the zone would make the browser navigate away to it — swallow that.
for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.preventDefault());

render();
