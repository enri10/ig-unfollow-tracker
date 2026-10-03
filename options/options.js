import * as storage from "../lib/storage.js";
import { setChecksPaused } from "../lib/scheduler.js";
import {
  sanitizeUsername,
  isValidUsername,
  clampSnapshotRetentionDays,
  clampDiffRetentionDays,
} from "../lib/utils.js";

const els = {
  username: document.getElementById("username"),
  usernameError: document.getElementById("usernameError"),
  checksPaused: document.getElementById("checksPaused"),
  notificationsEnabled: document.getElementById("notificationsEnabled"),
  trackFollowing: document.getElementById("trackFollowing"),
  snapshotRetentionDays: document.getElementById("snapshotRetentionDays"),
  diffRetentionDays: document.getElementById("diffRetentionDays"),
  saveBtn: document.getElementById("saveBtn"),
  savedNote: document.getElementById("savedNote"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  clearConfirmHint: document.getElementById("clearConfirmHint"),
};

async function load() {
  const settings = await storage.getSettings();
  els.username.value = settings.username || "";
  els.checksPaused.checked = settings.checksPaused;
  els.notificationsEnabled.checked = settings.notificationsEnabled;
  els.trackFollowing.checked = settings.trackFollowing;
  els.snapshotRetentionDays.value = settings.snapshotRetentionDays;
  els.diffRetentionDays.value = settings.diffRetentionDays;
}

async function save() {
  const username = sanitizeUsername(els.username.value);

  // Reject rather than silently save something that can never be a real
  // Instagram handle — without this, a bad paste (full profile URL, stray
  // punctuation) wouldn't surface until the next check fails with a
  // confusing API error, long after "Saved ✓" told the user it worked.
  if (username && !isValidUsername(username)) {
    els.usernameError.textContent =
      "That doesn't look like a valid Instagram username (letters, numbers, periods, underscores only).";
    els.usernameError.hidden = false;
    els.username.focus();
    return;
  }
  els.usernameError.hidden = true;
  els.username.value = username;

  await storage.setSettings({
    username,
    notificationsEnabled: els.notificationsEnabled.checked,
    trackFollowing: els.trackFollowing.checked,
    snapshotRetentionDays: clampSnapshotRetentionDays(els.snapshotRetentionDays.value),
    diffRetentionDays: clampDiffRetentionDays(els.diffRetentionDays.value),
  });
  // Reflect the clamped values back into the inputs so e.g. typing 9999
  // visibly settles on the actual saved number instead of looking accepted.
  const saved = await storage.getSettings();
  els.snapshotRetentionDays.value = saved.snapshotRetentionDays;
  els.diffRetentionDays.value = saved.diffRetentionDays;

  els.savedNote.hidden = false;
  setTimeout(() => (els.savedNote.hidden = true), 2000);
}

async function exportData() {
  const data = await storage.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ig-unfollow-tracker-export-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let clearArmed = false;
async function handleClear() {
  if (!clearArmed) {
    clearArmed = true;
    els.clearConfirmHint.hidden = false;
    setTimeout(() => {
      clearArmed = false;
      els.clearConfirmHint.hidden = true;
    }, 5000);
    return;
  }
  await storage.clearAllData();
  clearArmed = false;
  els.clearConfirmHint.hidden = true;
  await load();
  els.savedNote.textContent = "Cleared ✓";
  els.savedNote.hidden = false;
  setTimeout(() => {
    els.savedNote.hidden = true;
    els.savedNote.textContent = "Saved ✓";
  }, 2000);
}

// Takes effect immediately (syncs alarms via setChecksPaused), rather than
// waiting for "Save" — this is safety-critical enough that it shouldn't be
// possible to check the box and then forget to hit Save.
els.checksPaused.addEventListener("change", async () => {
  await setChecksPaused(els.checksPaused.checked);
});

els.username.addEventListener("input", () => {
  els.usernameError.hidden = true;
});

els.saveBtn.addEventListener("click", save);
els.exportBtn.addEventListener("click", exportData);
els.clearBtn.addEventListener("click", handleClear);

load();
