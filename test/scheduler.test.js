// Exercises performCheck's early-exit paths (paused / no-username / cooldown)
// against a minimal in-memory chrome.* mock, without ever reaching the real
// Instagram API — those are the branches that decide whether a request goes
// out at all, so they're worth covering deterministically even though the
// rest of performCheck needs a real browser.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { performCheck } from "../lib/scheduler.js";

function installChromeMock() {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve({ [key]: data[key] }),
        set: (obj) => {
          Object.assign(data, obj);
          return Promise.resolve();
        },
        clear: () => {
          for (const k of Object.keys(data)) delete data[k];
          return Promise.resolve();
        },
      },
    },
    alarms: {
      get: () => Promise.resolve(undefined),
      create: () => {},
      clear: () => Promise.resolve(),
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
    notifications: { create: () => {} },
  };
  return data;
}

beforeEach(() => {
  installChromeMock();
});

test("performCheck skips cleanly (not as an error) when no username is configured", async () => {
  const result = await performCheck({ manual: true });
  assert.deepEqual(result, { skipped: true, reason: "no-username" });

  const { attemptLog } = await chrome.storage.local.get("attemptLog");
  assert.equal(attemptLog.length, 1);
  assert.equal(attemptLog[0].outcome, "skipped");
  assert.equal(attemptLog[0].reason, "no-username");

  // Must not have left isCheckRunning stuck true, since it returns before
  // ever setting it.
  const { state } = await chrome.storage.local.get("state");
  assert.equal(state, undefined);
});

test("performCheck refuses to run while checksPaused is set, even manually", async () => {
  await chrome.storage.local.set({ settings: { username: "someone", checksPaused: true } });
  const result = await performCheck({ manual: true });
  assert.deepEqual(result, { skipped: true, reason: "paused" });
});

test("performCheck enforces the minimum gap between checks", async () => {
  await chrome.storage.local.set({ settings: { username: "someone" } });
  await chrome.storage.local.set({ state: { lastCheck: Date.now() } });
  const result = await performCheck({ manual: true });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "too-soon");
});

// ---- which request goes out first ----

function installInstagramMock({ cookies }) {
  const requests = [];
  chrome.cookies = { get: async ({ name }) => (name in cookies ? { value: cookies[name] } : null) };
  // The followers request answers 429 so the run stops right there, which keeps
  // these tests off IndexedDB while still showing exactly what was requested.
  globalThis.fetch = async (url) => {
    requests.push(new URL(url).pathname);
    return new Response("", { status: 429 });
  };
  return requests;
}

test("uses the id from the login cookie and never calls the profile lookup", async () => {
  await chrome.storage.local.set({ settings: { username: "me" } });
  const requests = installInstagramMock({ cookies: { sessionid: "s", csrftoken: "c", ds_user_id: "12345" } });

  const result = await performCheck({ manual: true });

  assert.equal(result.error.type, "RATE_LIMITED");
  assert.deepEqual(requests, ["/api/v1/friendships/12345/followers/"], "first and only request is the followers list");
  const { attemptLog } = await chrome.storage.local.get("attemptLog");
  assert.equal(attemptLog[0].stage, "followers");
});

test("falls back to the profile lookup only when the id cookie is missing", async () => {
  await chrome.storage.local.set({ settings: { username: "me" } });
  const requests = installInstagramMock({ cookies: { sessionid: "s", csrftoken: "c" } });

  await performCheck({ manual: true });

  assert.deepEqual(requests, ["/api/v1/users/web_profile_info/"]);
});

test("ignores a malformed id cookie instead of requesting /friendships/garbage/", async () => {
  await chrome.storage.local.set({ settings: { username: "me" } });
  const requests = installInstagramMock({ cookies: { sessionid: "s", csrftoken: "c", ds_user_id: "not-a-number" } });

  await performCheck({ manual: true });

  assert.deepEqual(requests, ["/api/v1/users/web_profile_info/"]);
});
