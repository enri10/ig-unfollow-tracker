// Pure diffing logic: comparing two snapshots to figure out who changed.
// Users are matched by numeric id (not username) since usernames can change.

function toMap(users) {
  const map = new Map();
  for (const u of users) map.set(u.id, u);
  return map;
}

/** Users present in `afterList` but not in `beforeList`. */
function added(beforeList, afterList) {
  const beforeIds = new Set(beforeList.map((u) => u.id));
  return afterList.filter((u) => !beforeIds.has(u.id));
}

/** Users present in `beforeList` but not in `afterList`. */
function removed(beforeList, afterList) {
  const afterIds = new Set(afterList.map((u) => u.id));
  return beforeList.filter((u) => !afterIds.has(u.id));
}

/**
 * Compare two snapshots and compute what changed.
 * @param {object|null} prevSnapshot - previous snapshot, or null if this is the first-ever check
 * @param {object} currSnapshot - newly-fetched snapshot
 * @param {object} [settings] - e.g. { trackNotFollowingBack }
 */
export function computeDiff(prevSnapshot, currSnapshot, settings = {}) {
  const prevFollowers = prevSnapshot ? prevSnapshot.followers : [];
  const prevFollowing = prevSnapshot ? prevSnapshot.following : [];

  const newFollowers = added(prevFollowers, currSnapshot.followers);
  const lostFollowers = removed(prevFollowers, currSnapshot.followers); // unfollowed you
  const newFollowing = added(prevFollowing, currSnapshot.following); // you followed
  const lostFollowing = removed(prevFollowing, currSnapshot.following); // you unfollowed

  const notFollowingBack = settings.trackNotFollowingBack === false
    ? []
    : added(currSnapshot.followers, currSnapshot.following);

  const renamed = currSnapshot.following
    .concat(currSnapshot.followers)
    .filter((u) => {
      const prevUser = toMap(prevFollowers.concat(prevFollowing)).get(u.id);
      return prevUser && prevUser.username && prevUser.username !== u.username;
    });

  return {
    id: `diff-${currSnapshot.id}`,
    generatedAt: Date.now(),
    comparedSnapshotIds: [prevSnapshot ? prevSnapshot.id : null, currSnapshot.id],
    newFollowers,
    lostFollowers,
    newFollowing,
    lostFollowing,
    notFollowingBack,
    renamed,
    followerCount: currSnapshot.followers.length,
    followingCount: currSnapshot.following.length,
    // Instagram's own displayed counts, for comparison against the two
    // above — see lib/scheduler.js for why these can legitimately differ.
    reportedFollowerCount: currSnapshot.reportedFollowerCount ?? null,
    reportedFollowingCount: currSnapshot.reportedFollowingCount ?? null,
  };
}

/**
 * Sort a notFollowingBack list into chronological order (oldest follow
 * first) and annotate each user with `followedSince`, using a map of
 * id -> epoch ms recording when we first observed each account in the
 * following list (see lib/storage.js getFollowingSince/setFollowingSince,
 * maintained by scheduler.js on every check). Instagram doesn't expose a
 * real "followed on" date, so this is "since we started tracking them" —
 * exact for anyone followed after tracking began, a lower bound for anyone
 * who was already followed on the very first check.
 * Users with no recorded "since" (shouldn't normally happen) sort last.
 */
export function sortNotFollowingBackChronologically(users, followingSinceMap) {
  return users
    .map((u) => ({ ...u, followedSince: followingSinceMap[u.id] ?? null }))
    .sort((a, b) => {
      if (a.followedSince == null && b.followedSince == null) return 0;
      if (a.followedSince == null) return 1;
      if (b.followedSince == null) return -1;
      return a.followedSince - b.followedSince;
    });
}
