import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiff, sortNotFollowingBackChronologically } from "../lib/diff.js";

function user(id, username) {
  return { id, username, fullName: "", profilePicUrl: null, isPrivate: false };
}

test("computeDiff treats a null previous snapshot as the first-ever check", () => {
  const curr = {
    id: "2026-01-02",
    followers: [user("1", "a"), user("2", "b")],
    following: [],
    followingCount: 0,
    reportedFollowerCount: 2,
    reportedFollowingCount: 0,
  };
  const diff = computeDiff(null, curr, { trackFollowing: false });
  assert.deepEqual(diff.newFollowers, curr.followers);
  assert.deepEqual(diff.lostFollowers, []);
  assert.equal(diff.comparedSnapshotIds[0], null);
});

test("computeDiff finds new and lost followers between two snapshots", () => {
  const prev = {
    id: "2026-01-01",
    followers: [user("1", "a"), user("2", "b")],
    following: [],
  };
  const curr = {
    id: "2026-01-02",
    followers: [user("1", "a"), user("3", "c")],
    following: [],
    followingCount: 0,
    reportedFollowerCount: null,
    reportedFollowingCount: null,
  };
  const diff = computeDiff(prev, curr, { trackFollowing: false });
  assert.deepEqual(diff.newFollowers.map((u) => u.id), ["3"]);
  assert.deepEqual(diff.lostFollowers.map((u) => u.id), ["2"]);
});

test("computeDiff keeps the following-derived lists empty when trackFollowing is off", () => {
  const prev = { id: "d1", followers: [user("1", "a")], following: [user("9", "z")] };
  const curr = {
    id: "d2",
    followers: [user("1", "a")],
    following: [], // not fetched when trackFollowing is off
    followingCount: 5, // Instagram's own reported count, used as a stand-in
    reportedFollowerCount: 1,
    reportedFollowingCount: 5,
  };
  const diff = computeDiff(prev, curr, { trackFollowing: false });
  assert.deepEqual(diff.newFollowing, []);
  assert.deepEqual(diff.lostFollowing, []);
  assert.deepEqual(diff.notFollowingBack, []);
  assert.equal(diff.followingCount, 5);
});

test("computeDiff populates following-derived lists when trackFollowing is on", () => {
  const prev = { id: "d1", followers: [], following: [user("9", "z")] };
  const curr = {
    id: "d2",
    followers: [user("1", "a")],
    following: [user("1", "a")], // follows "a" back, but "a" isn't in followers... wait see below
    followingCount: 1,
    reportedFollowerCount: 1,
    reportedFollowingCount: 1,
  };
  const diff = computeDiff(prev, curr, { trackFollowing: true });
  assert.deepEqual(diff.newFollowing.map((u) => u.id), ["1"]);
  assert.deepEqual(diff.lostFollowing.map((u) => u.id), ["9"]);
  // notFollowingBack = following accounts not present in followers.
  // Here followers=[1] and following=[1], so nobody is "not following back".
  assert.deepEqual(diff.notFollowingBack, []);
});

test("computeDiff flags accounts followed that aren't in the followers list as not-following-back", () => {
  const curr = {
    id: "d1",
    followers: [user("1", "a")],
    following: [user("1", "a"), user("2", "b")],
    followingCount: 2,
    reportedFollowerCount: 1,
    reportedFollowingCount: 2,
  };
  const diff = computeDiff(null, curr, { trackFollowing: true });
  assert.deepEqual(diff.notFollowingBack.map((u) => u.id), ["2"]);
});

test("sortNotFollowingBackChronologically orders oldest-followed first", () => {
  const users = [user("1", "a"), user("2", "b"), user("3", "c")];
  const since = { 1: 300, 2: 100, 3: 200 };
  const sorted = sortNotFollowingBackChronologically(users, since);
  assert.deepEqual(sorted.map((u) => u.id), ["2", "3", "1"]);
  assert.equal(sorted[0].followedSince, 100);
});

test("sortNotFollowingBackChronologically sorts missing-since users last", () => {
  const users = [user("1", "a"), user("2", "b")];
  const since = { 2: 100 }; // "1" has no recorded since
  const sorted = sortNotFollowingBackChronologically(users, since);
  assert.deepEqual(sorted.map((u) => u.id), ["2", "1"]);
  assert.equal(sorted[1].followedSince, null);
});
