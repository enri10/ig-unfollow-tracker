// Talks to Instagram's own web-client endpoints, relying on the cookies the
// browser already has for instagram.com (i.e. the user's normal, existing
// login session). This module never prompts for or stores credentials.
//
// NOTE: these are undocumented internal endpoints. Instagram can change the
// paths, headers, or response shape at any time without notice. Before
// relying on this in production, capture real requests via DevTools (see
// Phase 0 in the project plan) and adjust IG_APP_ID / paths / field names
// below if they've drifted. Parsing here is defensive on purpose: prefer
// throwing a clear InstagramApiError over silently misinterpreting data.

import { randomDelay } from "./utils.js";

const ORIGIN = "https://www.instagram.com";
// Public constant used by Instagram's own web client (widely observed in
// captured traffic / open-source IG API clients). Reconfirm via DevTools if
// requests start failing.
const IG_APP_ID = "936619743392459";

export class InstagramApiError extends Error {
  constructor(type, message, { status, body } = {}) {
    super(message);
    this.name = "InstagramApiError";
    this.type = type; // 'NOT_LOGGED_IN' | 'CHALLENGE_REQUIRED' | 'RATE_LIMITED' | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE'
    this.status = status;
    this.body = body;
  }
}

async function getCookie(name) {
  const cookie = await chrome.cookies.get({ url: ORIGIN, name });
  return cookie ? cookie.value : null;
}

/** True if the browser currently has an Instagram session cookie. Cheap pre-flight check. */
export async function isLoggedIn() {
  const sessionId = await getCookie("sessionid");
  return Boolean(sessionId);
}

async function igFetch(path, { params } = {}) {
  const csrfToken = await getCookie("csrftoken");
  const url = new URL(path, ORIGIN);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "*/*",
        "X-IG-App-ID": IG_APP_ID,
        ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
        "X-Requested-With": "XMLHttpRequest",
      },
    });
  } catch (err) {
    throw new InstagramApiError("NETWORK_ERROR", `Network error contacting Instagram: ${err.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new InstagramApiError("NOT_LOGGED_IN", "Instagram rejected the request as unauthenticated.", {
      status: response.status,
    });
  }
  if (response.status === 429) {
    throw new InstagramApiError("RATE_LIMITED", "Instagram is rate-limiting this session.", {
      status: response.status,
    });
  }

  let json;
  const text = await response.text();
  try {
    json = JSON.parse(text);
  } catch {
    throw new InstagramApiError("UNEXPECTED_RESPONSE", "Instagram returned a non-JSON response (likely a login/challenge page).", {
      status: response.status,
      body: text.slice(0, 500),
    });
  }

  if (json && (json.checkpoint_url || json.challenge_required || /checkpoint/i.test(json.message || ""))) {
    throw new InstagramApiError("CHALLENGE_REQUIRED", "Instagram is asking for additional verification (checkpoint).", {
      status: response.status,
      body: json,
    });
  }

  if (!response.ok) {
    throw new InstagramApiError("UNEXPECTED_RESPONSE", `Instagram returned an unexpected error (${response.status}).`, {
      status: response.status,
      body: json,
    });
  }

  return json;
}

/** Resolve a username to its numeric id + basic public counts. */
export async function fetchUserId(username) {
  const json = await igFetch("/api/v1/users/web_profile_info/", { params: { username } });
  const user = json && json.data && json.data.user;
  if (!user || !user.id) {
    throw new InstagramApiError("UNEXPECTED_RESPONSE", "Could not find user id in profile response — response shape may have changed.", {
      body: json,
    });
  }
  return {
    id: String(user.id),
    username: user.username || username,
    followerCount: user.edge_followed_by ? user.edge_followed_by.count : null,
    followingCount: user.edge_follow ? user.edge_follow.count : null,
    profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || null,
  };
}

function normalizeUser(raw) {
  return {
    id: String(raw.pk ?? raw.id ?? raw.pk_id ?? ""),
    username: raw.username || "",
    fullName: raw.full_name || "",
    profilePicUrl: raw.profile_pic_url || null,
    isPrivate: Boolean(raw.is_private),
  };
}

/**
 * Fetch a single page of a followers/following list.
 * listType: 'followers' | 'following'
 */
async function fetchFriendshipsPage(userId, listType, maxId) {
  const json = await igFetch(`/api/v1/friendships/${userId}/${listType}/`, {
    params: { count: 50, max_id: maxId || undefined },
  });

  const users = Array.isArray(json.users) ? json.users.map(normalizeUser) : null;
  if (!users) {
    throw new InstagramApiError("UNEXPECTED_RESPONSE", `Unexpected ${listType} response shape — 'users' array missing.`, {
      body: json,
    });
  }

  // Field name for "is there another page" / "cursor for next page" has
  // varied across IG API versions; check the known candidates defensively.
  const nextMaxId = json.next_max_id || null;
  const hasMore = Boolean(json.big_list ? nextMaxId : json.has_more ?? Boolean(nextMaxId));

  return { users, nextMaxId, hasMore: hasMore && Boolean(nextMaxId) };
}

/**
 * Fetch a full followers or following list, paginating with conservative
 * pacing. Supports resuming from a previously-collected partial list + cursor
 * (see lib/scheduler.js) so a killed MV3 service worker doesn't force a full
 * restart.
 *
 * @param {string} userId
 * @param {'followers'|'following'} listType
 * @param {object} [opts]
 * @param {Array} [opts.resumeCollected] - users already collected in a prior partial run
 * @param {string|null} [opts.resumeMaxId] - cursor to resume from
 * @param {(collectedCount: number) => void} [opts.onPage] - progress callback, called after each page
 * @param {(collected: Array, nextMaxId: string|null) => Promise<void>} [opts.onCheckpoint] - persist progress after each page
 */
export async function fetchFriendshipList(userId, listType, opts = {}) {
  const { resumeCollected = [], resumeMaxId = null, onPage, onCheckpoint } = opts;
  const collected = [...resumeCollected];
  let maxId = resumeMaxId;
  let first = true;

  while (true) {
    if (!first) {
      await randomDelay(1500, 3500);
    }
    first = false;

    const { users, nextMaxId, hasMore } = await fetchFriendshipsPage(userId, listType, maxId);
    collected.push(...users);
    maxId = nextMaxId;

    if (onPage) onPage(collected.length);
    if (onCheckpoint) await onCheckpoint(collected, hasMore ? maxId : null);

    if (!hasMore) break;
  }

  return collected;
}
