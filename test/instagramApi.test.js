import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchUserId, fetchFriendshipList, InstagramApiError } from "../lib/instagramApi.js";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.chrome = { cookies: { get: async () => ({ value: "x" }) } };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
});

const reply = (body, { status = 200, type = "application/json" } = {}) =>
  async () => new Response(body, { status, headers: { "content-type": type } });

test("an HTML login page is reported with its stage, status and what it looked like", async () => {
  globalThis.fetch = reply("<!DOCTYPE html>\n<html><title>Login • Instagram</title>", { type: "text/html; charset=utf-8" });
  const err = await fetchUserId("me").catch((e) => e);
  assert.ok(err instanceof InstagramApiError);
  assert.equal(err.type, "UNEXPECTED_RESPONSE");
  assert.equal(err.stage, "profile");
  assert.equal(err.status, 200);
  assert.match(err.detail, /^HTTP 200, text\/html: <!DOCTYPE html> <html>/, "whitespace collapsed to one line");
});

test("a JSON error status carries the status and body in the detail", async () => {
  globalThis.fetch = reply('{"message":"useragent mismatch","status":"fail"}', { status: 400 });
  const err = await fetchUserId("me").catch((e) => e);
  assert.equal(err.type, "UNEXPECTED_RESPONSE");
  assert.match(err.detail, /HTTP 400, application\/json: .*useragent mismatch/);
});

test("200 JSON without a user id says which keys it did return", async () => {
  globalThis.fetch = reply('{"data":{},"status":"ok","extra":1}');
  const err = await fetchUserId("me").catch((e) => e);
  assert.equal(err.stage, "profile");
  assert.match(err.detail, /no user id; top-level keys: data, status, extra/);
});

test("followers response without a users array is tagged with the list stage", async () => {
  globalThis.fetch = reply('{"status":"ok"}');
  const err = await fetchFriendshipList("1", "followers").catch((e) => e);
  assert.equal(err.stage, "followers");
  assert.match(err.detail, /no users array; top-level keys: status/);
});

test("the detail is bounded (a huge body can't bloat storage)", async () => {
  globalThis.fetch = reply("x".repeat(50_000), { type: "text/html" });
  const err = await fetchUserId("me").catch((e) => e);
  assert.ok(err.detail.length < 260, `detail was ${err.detail.length} chars`);
});

test("429 is still classified as rate-limited, with its stage", async () => {
  globalThis.fetch = async () => new Response("", { status: 429 });
  const err = await fetchUserId("me").catch((e) => e);
  assert.equal(err.type, "RATE_LIMITED");
  assert.equal(err.stage, "profile");
});
