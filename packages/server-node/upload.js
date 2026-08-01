// POST /api/upload — commits an image to the repo via the GitHub Contents API
// and hands back the site-relative URL to drop into content.
//
//   { filename: "Beach Photo.JPG", dataBase64: "…" }  (a data: URL prefix is fine)
//   → { ok: true, url: "/images/1a2b3c4d-beach-photo.jpg",
//       path: "web/images/1a2b3c4d-beach-photo.jpg", commit: "<sha or null>" }
//
// Same contract as save.js: read-only by default (no token → 501), auth fails
// CLOSED, and the auth block is copied rather than imported so every handler
// stays a standalone drop-in file. Uploads land in PLATER_IMAGES_DIR, default
// the "images" dir next to the content dir (web/content/site.json → web/images).
// The final name is prefixed with 8 hex chars of the content hash so two
// different "photo.jpg" uploads can never clobber each other.
import path from 'node:path';
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || '').toLowerCase();
// Commits need a valid git identity even when the shared edit token (which
// carries no email) is the credential used.
const COMMIT_EMAIL = ADMIN_EMAIL || 'plater@users.noreply.github.com';
const SIGN_IN = ADMIN_EMAIL ? `sign in as ${ADMIN_EMAIL}` : 'sign in with the authorized account';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';

// Public web root is the parent of the content dir: web/content/site.json → web.
const CONTENT_DIR = path.posix.dirname(CONTENT_PATH.split(path.sep).join('/'));
const WEB_ROOT = path.posix.dirname(CONTENT_DIR);
const IMAGES_DIR = path.posix
  .normalize((process.env.PLATER_IMAGES_DIR || path.posix.join(WEB_ROOT, 'images')).split(path.sep).join('/'))
  .replace(/^(\.\.\/|\/)+/, '').replace(/\/+$/, '');

// SVG is allowed because sites legitimately upload logos; it is script-capable,
// so serve the images dir as static assets, never inline it into a page.
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const MAX_BYTES = 4 * 1024 * 1024; // decoded
// Base64 is 4/3 the size; leave room for the JSON envelope around it.
const MAX_BODY = Math.ceil(MAX_BYTES * 4 / 3) + 64 * 1024;

/* ---------------- auth (same contract as save.js) ---------------- */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogle(idToken) {
  // Fail CLOSED: with no CMS_ADMIN_EMAIL configured there is no one to
  // authorize, so an empty allowlist must never match an empty token email.
  if (!ADMIN_EMAIL) return { ok: false, reason: 'CMS_ADMIN_EMAIL is not set' };
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return { ok: false, reason: 'tokeninfo ' + r.status };
  const t = await r.json();
  if (GOOGLE_CLIENT_ID && t.aud !== GOOGLE_CLIENT_ID) return { ok: false, reason: 'aud mismatch' };
  if (String(t.email_verified) !== 'true') return { ok: false, reason: 'email not verified' };
  if ((t.email || '').toLowerCase() !== ADMIN_EMAIL) return { ok: false, reason: 'not an admin' };
  const now = Math.floor(Date.now() / 1000);
  if (t.exp && now > Number(t.exp)) return { ok: false, reason: 'token expired' };
  return { ok: true, email: t.email };
}

/* ---------------- naming ---------------- */

// A filename is untrusted input from a browser: take the basename only (kills
// "../" and absolute paths on both separators), then slug the stem.
export function safeName(filename, buf) {
  const raw = String(filename || '').split(/[\\/]/).pop().trim();
  if (!raw || raw.includes('\0')) return { error: 'bad filename' };
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : '';
  if (!ALLOWED_EXT.has(ext)) return { error: `unsupported file type (allowed: ${[...ALLOWED_EXT].join(', ')})` };
  const slug = raw.slice(0, dot)
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'image';
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  return { name: `${hash}-${slug}.${ext}` };
}

// GitHub's file `sha` is the git blob id, so we can tell "already uploaded,
// byte for byte" from "8-hex-char collision" without downloading the content.
function gitBlobSha(buf) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]))
    .digest('hex');
}

/* ---------------- write side (GitHub commit, like save.js) ---------------- */

async function commitImage(rel, buf, who) {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN' };
  if (!GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_REPOSITORY' };

  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${rel}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let sha;
  const get = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers, cache: 'no-store' });
  if (get.ok) {
    const file = await get.json();
    // Identical bytes already at this path → nothing to commit, same URL.
    if (file.sha === gitBlobSha(buf)) return { ok: true, commit: null };
    sha = file.sha;
  } else if (get.status !== 404) {
    return { ok: false, status: 502, error: `github read ${get.status}: ${(await get.text()).slice(0, 300)}` };
  }

  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `image(${SITE_NAME}): upload ${path.posix.basename(rel)} via CMS by ${who}`,
      content: buf.toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'Plater CMS', email: COMMIT_EMAIL },
      author: { name: who || 'Plater CMS', email: who || COMMIT_EMAIL },
    }),
  });
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 300)}` };
  return { ok: true, commit: (await put.json()).commit?.sha ?? null };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return res.status(401).json({ error: `${SIGN_IN} to upload` });

  let who;
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) {
    who = ADMIN_EMAIL;
  } else {
    const v = await verifyGoogle(auth).catch((e) => ({ ok: false, reason: e.message }));
    if (!v.ok) {
      const reason = EDIT_TOKEN ? 'bad edit token or Google auth: ' + v.reason : v.reason;
      return res.status(401).json({ error: 'auth failed: ' + reason });
    }
    who = v.email;
  }

  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return res.status(413).json({ error: 'image too large (4 MB max)' });

  let payload;
  try {
    payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ error: 'expected JSON { filename, dataBase64 }' });
  }
  if (typeof payload.filename !== 'string' || typeof payload.dataBase64 !== 'string') {
    return res.status(400).json({ error: 'expected { filename, dataBase64 }' });
  }

  // Accept a whole data: URL as well as bare base64; whitespace is legal in
  // base64 transport and browsers/agents both emit it.
  const b64 = payload.dataBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!b64) return res.status(400).json({ error: 'empty image' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return res.status(400).json({ error: 'dataBase64 is not base64' });
  // Reject on the encoded length first — never allocate a buffer we would only
  // turn around and refuse.
  if (Math.floor(b64.length * 3 / 4) > MAX_BYTES) return res.status(413).json({ error: 'image too large (4 MB max)' });
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty image' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'image too large (4 MB max)' });

  const named = safeName(payload.filename, buf);
  if (named.error) return res.status(400).json({ error: named.error });

  const rel = path.posix.join(IMAGES_DIR, named.name);
  const gh = await commitImage(rel, buf, who);
  if (!gh.ok) return res.status(gh.status || 500).json({ error: gh.error });

  // Site-relative URL: strip the public web root off the repo path when the
  // images dir lives under it, so web/images/x.png serves as /images/x.png.
  const url = rel.startsWith(WEB_ROOT + '/') ? '/' + rel.slice(WEB_ROOT.length + 1) : '/' + rel;
  return res.status(200).json({ ok: true, url, path: rel, commit: gh.commit ?? null });
}
