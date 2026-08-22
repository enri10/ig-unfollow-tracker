# IG Unfollow Tracker

A Chrome (Manifest V3) extension that tracks who unfollows you on Instagram, by
taking a daily snapshot of your followers/following and diffing it against the
previous one.

**It never asks for your Instagram password.** It reads data through your
browser's *existing* Instagram session — the same cookies already present
because you're normally logged into instagram.com in that browser — the same
trust model as any extension that reads Gmail while you're logged into Gmail.

## Why it needs you to be logged in at all

Instagram no longer exposes the actual followers/following *list* (usernames)
to logged-out requests, even for public profiles — only the numeric counts.
Getting real usernames (needed to know *who* unfollowed you, not just that
your count dropped) requires an authenticated session. This extension doesn't
create that session itself; it just uses the one you already have.

## Setup

1. Log into instagram.com normally, in the Chrome profile you'll use this
   extension in.
2. Go to `chrome://extensions`, enable **Developer mode** (top right), click
   **Load unpacked**, and select this folder.
3. Click the extension icon → the gear ⚙ icon (or right-click the icon →
   Options) → enter your Instagram username → **Save**.
4. Click **Check now** in the popup for the first baseline snapshot. The
   first check has nothing to compare against, so it won't show any
   "unfollowed you" yet — that shows up starting from the *second* check.
5. It also re-checks automatically once a day while Chrome is running (via
   `chrome.alarms`). A fully closed browser can't run anything — the next
   check happens whenever Chrome (and this extension) is next open.

## Before relying on this: verify the Instagram endpoints

Instagram's internal web endpoints (`lib/instagramApi.js`) are undocumented
and can change at any time without notice. Before trusting this day to day:

1. Log into instagram.com, open DevTools → Network → Fetch/XHR.
2. Go to your profile, open "Followers", scroll to trigger pagination, then
   repeat for "Following".
3. Compare the captured request URLs/headers (`X-IG-App-ID`, `X-CSRFToken`,
   etc.) and response JSON shape against what `lib/instagramApi.js` expects.
   Adjust the constants/field names there if they've drifted.

If something has changed, the popup will surface a clear error (see below)
rather than silently showing wrong data — `lib/instagramApi.js` is written to
fail loudly on unexpected response shapes.

## What it tracks

- **Unfollowed you** — people who were following you last check but aren't now (the main feature).
- **New followers** / **You unfollowed** / **New follows**.
- **Not following back** (optional, toggle in Settings) — people you follow who don't follow you.
- **History** — a searchable log of every past check's changes.

## Data & privacy

Everything is stored locally in this browser (`chrome.storage.local` +
IndexedDB) — nothing is sent anywhere except to instagram.com itself, using
your own session. Use **Settings → Export data as JSON** to back it up, or
**Clear all data** to wipe it.

## Known limitations / risks

- **Browser must be running.** No extension can run with the browser fully closed.
- **Instagram Terms of Service**: this reads data via undocumented internal
  endpoints rather than an official API (Instagram doesn't offer one for
  follower lists). This is read-only and only ever touches your own account's
  data, but it's still against Instagram's ToS, and could in theory trigger a
  rate-limit or verification checkpoint on your account if run too
  aggressively. The extension paces requests conservatively and backs off on
  errors rather than retrying hard, but there's no guarantee against this.
- Large accounts (thousands of followers) take longer to check due to
  deliberate pacing between pages — this is intentional, not a bug.

## Troubleshooting

The popup shows a banner for these states instead of failing silently:
- **Not logged in** → log into instagram.com in this browser, then retry.
- **Challenge required** → Instagram wants extra verification; resolve it on
  instagram.com, then click Check now again.
- **Rate limited** → wait; it'll retry automatically.
- **Unexpected response** → the endpoint shape likely changed; see the
  reconnaissance steps above.
