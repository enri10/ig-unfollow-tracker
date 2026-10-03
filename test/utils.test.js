import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clamp,
  sanitizeUsername,
  isValidUsername,
  clampSnapshotRetentionDays,
  clampDiffRetentionDays,
  SNAPSHOT_RETENTION_MIN_DAYS,
  SNAPSHOT_RETENTION_MAX_DAYS,
  SNAPSHOT_RETENTION_DEFAULT_DAYS,
  DIFF_RETENTION_MIN_DAYS,
  DIFF_RETENTION_MAX_DAYS,
  DIFF_RETENTION_DEFAULT_DAYS,
  formatDateTime,
  formatDate,
  formatRelativeDay,
  formatTime,
} from "../lib/utils.js";

test("clamp keeps values inside [min, max]", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
});

test("sanitizeUsername strips @ prefix and whitespace", () => {
  assert.equal(sanitizeUsername("  @someone  "), "someone");
  assert.equal(sanitizeUsername("@@someone"), "someone");
  assert.equal(sanitizeUsername("someone"), "someone");
});

test("sanitizeUsername extracts the handle from a pasted profile URL", () => {
  assert.equal(sanitizeUsername("https://www.instagram.com/someone/"), "someone");
  assert.equal(sanitizeUsername("instagram.com/someone"), "someone");
});

test("sanitizeUsername handles null/undefined/empty input", () => {
  assert.equal(sanitizeUsername(null), "");
  assert.equal(sanitizeUsername(undefined), "");
  assert.equal(sanitizeUsername(""), "");
  assert.equal(sanitizeUsername("   "), "");
});

test("isValidUsername accepts normal handles", () => {
  assert.equal(isValidUsername("john_doe.99"), true);
  assert.equal(isValidUsername("a"), true);
  assert.equal(isValidUsername("a".repeat(30)), true);
});

test("isValidUsername rejects empty, too-long, and bad-character input", () => {
  assert.equal(isValidUsername(""), false);
  assert.equal(isValidUsername(null), false);
  assert.equal(isValidUsername("a".repeat(31)), false);
  assert.equal(isValidUsername("bad name"), false);
  assert.equal(isValidUsername("bad/name"), false);
  assert.equal(isValidUsername("@stillhasat"), false);
});

test("isValidUsername rejects leading/trailing/doubled periods", () => {
  assert.equal(isValidUsername(".leading"), false);
  assert.equal(isValidUsername("trailing."), false);
  assert.equal(isValidUsername("double..dot"), false);
});

test("clampSnapshotRetentionDays clamps to the documented bounds", () => {
  assert.equal(clampSnapshotRetentionDays(1), SNAPSHOT_RETENTION_MIN_DAYS);
  assert.equal(clampSnapshotRetentionDays(9999), SNAPSHOT_RETENTION_MAX_DAYS);
  assert.equal(clampSnapshotRetentionDays(30), 30);
  assert.equal(clampSnapshotRetentionDays(30.6), 31);
});

test("clampSnapshotRetentionDays falls back on non-numeric input", () => {
  assert.equal(clampSnapshotRetentionDays(""), SNAPSHOT_RETENTION_DEFAULT_DAYS);
  assert.equal(clampSnapshotRetentionDays("not a number"), SNAPSHOT_RETENTION_DEFAULT_DAYS);
  assert.equal(clampSnapshotRetentionDays(null), SNAPSHOT_RETENTION_DEFAULT_DAYS);
  assert.equal(clampSnapshotRetentionDays(undefined), SNAPSHOT_RETENTION_DEFAULT_DAYS);
  assert.equal(clampSnapshotRetentionDays(NaN), SNAPSHOT_RETENTION_DEFAULT_DAYS);
});

test("clampDiffRetentionDays clamps to the documented bounds", () => {
  assert.equal(clampDiffRetentionDays(1), DIFF_RETENTION_MIN_DAYS);
  assert.equal(clampDiffRetentionDays(99999), DIFF_RETENTION_MAX_DAYS);
  assert.equal(clampDiffRetentionDays(180), 180);
});

test("clampDiffRetentionDays falls back on non-numeric input", () => {
  assert.equal(clampDiffRetentionDays("nope"), DIFF_RETENTION_DEFAULT_DAYS);
  assert.equal(clampDiffRetentionDays(null), DIFF_RETENTION_DEFAULT_DAYS);
});

test("formatDateTime/formatDate/formatRelativeDay/formatTime handle the falsy case", () => {
  assert.equal(formatDateTime(null), "never");
  assert.equal(formatDateTime(0), "never");
  assert.equal(formatDate(null), null);
  assert.equal(formatRelativeDay(null), "");
  assert.equal(formatTime(null), "");
});

test("formatRelativeDay reports Today/Yesterday relative to now", () => {
  const now = Date.now();
  assert.equal(formatRelativeDay(now), "Today");
  assert.equal(formatRelativeDay(now - 24 * 60 * 60 * 1000), "Yesterday");
});
