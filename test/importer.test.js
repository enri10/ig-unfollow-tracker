import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import {
  classifyExportFile,
  parseInstagramExport,
  readZipEntries,
  readInputFiles,
  reconcileIds,
  ImportError,
} from "../lib/importer.js";

// ---- fixtures in the shapes Instagram's JSON export uses ----

const followersJson = (names, ts = 1_700_000_000) =>
  JSON.stringify(
    names.map((n, i) => ({
      title: "",
      media_list_data: [],
      string_list_data: [{ href: `https://www.instagram.com/${n}`, value: n, timestamp: ts + i }],
    }))
  );

// following.json wraps its list and puts the handle in `title`, with a `_u/` href and no `value`.
const followingJson = (names, ts = 1_600_000_000) =>
  JSON.stringify({
    relationships_following: names.map((n, i) => ({
      title: n,
      media_list_data: [],
      string_list_data: [{ href: `https://www.instagram.com/_u/${n}`, timestamp: ts + i }],
    })),
  });

/** Minimal zip writer: stored (method 0) or deflated (method 8) entries. */
function makeZip(files, { deflate = true } = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.forEach((b, i) => (local[30 + i] = b));
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.forEach((b, i) => (central[46 + i] = b));
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Blob([Buffer.concat([...locals, cd, eocd])]);
}

// ---- classification ----

test("classifyExportFile picks only the followers/following files", () => {
  assert.equal(classifyExportFile("followers_1.json"), "followers");
  assert.equal(classifyExportFile("connections/followers_and_following/followers_12.json"), "followers");
  assert.equal(classifyExportFile("FOLLOWERS_1.HTML"), "followers");
  assert.equal(classifyExportFile("connections\\followers_and_following\\following.json"), "following");
  for (const noise of [
    "following_hashtags.json",
    "recently_unfollowed_profiles.json",
    "pending_follow_requests.json",
    "close_friends.json",
    "blocked_profiles.json",
    "followers_1.json.bak",
    "my_followers.json",
  ]) {
    assert.equal(classifyExportFile(noise), null, noise);
  }
});

// ---- parsing ----

test("parses followers_1.json (handle in `value`) and following.json (handle in `title`, _u/ href)", () => {
  const r = parseInstagramExport([
    { name: "followers_1.json", text: followersJson(["alice", "Bob_2"]) },
    { name: "following.json", text: followingJson(["alice", "carol.x"]) },
  ]);
  assert.deepEqual(r.followers.map((u) => u.username), ["alice", "Bob_2"]);
  assert.deepEqual(r.following.map((u) => u.username), ["alice", "carol.x"]);
  assert.equal(r.followers[0].followedAt, 1_700_000_000 * 1000, "timestamps become epoch ms");
  assert.equal(r.following[1].followedAt, (1_600_000_000 + 1) * 1000);
  assert.deepEqual(r.notes, []);
});

test("ids are case-insensitive username keys; duplicates collapse", () => {
  const r = parseInstagramExport([
    { name: "followers_1.json", text: followersJson(["Alice", "alice", "bob"]) },
    { name: "following.json", text: followingJson(["bob"]) },
  ]);
  assert.equal(r.followers.length, 2);
  assert.equal(r.followers[0].id, "u:alice");
});

test("merges followers_1.json + followers_2.json for large accounts", () => {
  const r = parseInstagramExport([
    { name: "followers_1.json", text: followersJson(["a", "b"]) },
    { name: "followers_2.json", text: followersJson(["c"]) },
    { name: "following.json", text: followingJson(["a"]) },
  ]);
  assert.deepEqual(r.followers.map((u) => u.username), ["a", "b", "c"]);
});

test("HTML export: extracts handles from profile links, ignores other links, notes the missing dates", () => {
  const html = `<html><body>
    <a href="https://help.instagram.com/x">help</a>
    <a href="https://www.instagram.com/alice">alice</a>
    <a href="https://www.instagram.com/_u/bob.b/">bob.b</a>
    <a href="https://www.instagram.com/accounts/login/">login</a></body></html>`;
  const r = parseInstagramExport([
    { name: "followers_1.html", text: html },
    { name: "following.html", text: html },
  ]);
  assert.deepEqual(r.followers.map((u) => u.username), ["alice", "bob.b"]);
  assert.equal(r.followers[0].followedAt, null);
  assert.ok(r.notes.some((n) => /HTML/.test(n)));
});

test("followers present but no following file: still imports, and says what's unavailable", () => {
  const r = parseInstagramExport([{ name: "followers_1.json", text: followersJson(["a"]) }]);
  assert.equal(r.following.length, 0);
  assert.ok(r.notes.some((n) => /following\.json/.test(n)));
});

test("errors are specific, not generic", () => {
  assert.throws(() => parseInstagramExport([]), (e) => e instanceof ImportError && /followers_1\.json/.test(e.message));
  assert.throws(
    () => parseInstagramExport([{ name: "followers_1.json", text: "<not json" }]),
    (e) => e instanceof ImportError && /JSON/.test(e.message)
  );
  assert.throws(
    () => parseInstagramExport([{ name: "following.json", text: followingJson(["a"]) }]),
    (e) => e instanceof ImportError && /no followers/.test(e.message)
  );
});

// ---- zip ----

test("reads followers/following out of a real deflated zip, ignoring everything else in it", async () => {
  const zip = makeZip({
    "connections/followers_and_following/followers_1.json": followersJson(["alice", "bob"]),
    "connections/followers_and_following/following.json": followingJson(["bob"]),
    "connections/followers_and_following/following_hashtags.json": "{}",
    "your_instagram_activity/messages/inbox/secret.json": "SHOULD-NEVER-BE-READ",
  });
  const entries = await readZipEntries(zip, (n) => classifyExportFile(n) !== null);
  assert.equal(entries.length, 2);
  assert.ok(!entries.some((e) => e.text.includes("SHOULD-NEVER-BE-READ")));
  const r = parseInstagramExport(entries);
  assert.deepEqual(r.followers.map((u) => u.username), ["alice", "bob"]);
  assert.deepEqual(r.following.map((u) => u.username), ["bob"]);
});

test("zip: stored (uncompressed) entries work too, and non-zip input is rejected clearly", async () => {
  const zip = makeZip({ "followers_1.json": followersJson(["a"]) }, { deflate: false });
  const [e] = await readZipEntries(zip, () => true);
  assert.deepEqual(JSON.parse(e.text).length, 1);
  await assert.rejects(() => readZipEntries(new Blob(["definitely not a zip"]), () => true), /valid \.zip/);
});

test("readInputFiles accepts a zip or loose files and skips unrelated files", async () => {
  const zipFile = new File([makeZip({ "followers_1.json": followersJson(["z"]) })], "export.zip");
  const loose = new File([followingJson(["q"])], "following.json");
  const junk = new File(["x"], "notes.txt");
  const entries = await readInputFiles([zipFile, loose, junk]);
  assert.deepEqual(entries.map((e) => classifyExportFile(e.name)).sort(), ["followers", "following"]);
});

// ---- id reconciliation ----

test("reconcileIds reuses ids, names and pictures from an earlier live snapshot (matched by username)", () => {
  const prev = {
    followers: [{ id: "777", username: "Alice", fullName: "Alice A", profilePicUrl: "http://pic", isPrivate: true }],
    following: [],
  };
  const imported = parseInstagramExport([
    { name: "followers_1.json", text: followersJson(["alice", "newperson"]) },
  ]).followers;
  const [alice, newperson] = reconcileIds(imported, prev);
  assert.equal(alice.id, "777");
  assert.equal(alice.fullName, "Alice A");
  assert.equal(alice.isPrivate, true);
  assert.equal(newperson.id, "u:newperson");
  assert.equal(reconcileIds(imported, null), imported, "no baseline → unchanged");
});
