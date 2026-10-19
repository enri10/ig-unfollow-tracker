// DOM helpers shared by the popup and the import/lists page.

/** A round letter badge, used when there's no picture or it fails to load. */
function fallbackAvatar(username) {
  const el = document.createElement("div");
  el.className = "avatar avatar-fallback";
  el.textContent = (username || "?").replace(/^[^A-Za-z0-9]+/, "").charAt(0).toUpperCase() || "?";
  return el;
}

/**
 * One account as a link to its Instagram profile.
 * @param {object} user
 * @param {string} [caption] - overrides the second line (defaults to the full name)
 */
export function userRow(user, caption) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.className = "user-row";
  a.href = `https://www.instagram.com/${encodeURIComponent(user.username)}/`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  let avatar;
  if (user.profilePicUrl) {
    // Instagram's picture URLs are signed and expire, so a stored one is often dead
    // by the time it's shown — fall back to a letter badge instead of a broken-image icon.
    avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.loading = "lazy";
    avatar.referrerPolicy = "no-referrer";
    avatar.alt = "";
    avatar.addEventListener("error", () => avatar.replaceWith(fallbackAvatar(user.username)), { once: true });
    avatar.src = user.profilePicUrl;
  } else {
    avatar = fallbackAvatar(user.username);
  }

  const meta = document.createElement("div");
  meta.className = "user-meta";
  const uname = document.createElement("div");
  uname.className = "username";
  uname.textContent = `@${user.username}`;
  const full = document.createElement("div");
  full.className = "full-name";
  full.textContent = caption ?? (user.fullName || "");
  meta.append(uname, full);

  a.append(avatar, meta);
  li.append(a);
  return li;
}
