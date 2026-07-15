// POST /api/save — verifies admin auth (Google ID token OR shared edit token),
// merges the posted content, and commits it to GitHub via the Contents API.
// Read-only by default: no token/credentials → no write. Extracted verbatim
// from the Sherwood reference implementation (env-parameterized already).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || 'zach@thekitchen.co').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Optional shared-secret fallback so an admin can edit before Google SSO is wired
// (e.g. from an iPad). A high-entropy bearer token, compared in constant time.
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_EDIT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';
const MAX_BODY = 2_000_000;

async function verifyGoogle(idToken) {
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

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

async function readBaseContent() {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), GITHUB_EDIT_PATH), 'utf8'));
  } catch {
    return {};
  }
}

async function commitToGitHub(content, who, track) {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN' };
  if (!GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_REPOSITORY' };

  // A track save writes the track's OVERLAY file, never the live content.
  const editPath = track
    ? `${GITHUB_EDIT_PATH.split('/').slice(0, -1).join('/')}/versions/${track}/site.json`
    : GITHUB_EDIT_PATH;
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${editPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let sha;
  const get = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers, cache: 'no-store' });
  if (get.ok) {
    const file = await get.json();
    sha = file.sha;
  } else if (get.status !== 404) {
    return { ok: false, status: 502, error: `github read ${get.status}: ${(await get.text()).slice(0, 300)}` };
  }

  const body = {
    message: track
      ? `draft(${SITE_NAME}): ${track} track edit via CMS by ${who}`
      : `content(${SITE_NAME}): edit via CMS by ${who}`,
    content: Buffer.from(stableJson(content)).toString('base64'),
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
    committer: { name: 'Heard CMS', email: ADMIN_EMAIL },
    author: { name: 'Zach Phillips', email: ADMIN_EMAIL },
  };

  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 300)}` };
  const result = await put.json();
  return { ok: true, sha: result.commit?.sha };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return res.status(401).json({ error: `sign in as ${ADMIN_EMAIL} to save` });

  // Accept either the shared edit token (when configured) or a Google ID token.
  let verifiedEmail;
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) {
    verifiedEmail = ADMIN_EMAIL;
  } else {
    const verified = await verifyGoogle(auth);
    if (!verified.ok) {
      const reason = EDIT_TOKEN ? 'bad edit token or Google auth: ' + verified.reason : verified.reason;
      return res.status(401).json({ error: 'auth failed: ' + reason });
    }
    verifiedEmail = verified.email;
  }

  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return res.status(413).json({ error: 'payload too large' });

  const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

  // { promote: "opus" } — MAKE THIS DRAFT LIVE, one click, no agent. The
  // client sends the draft content it is currently rendering (already the
  // overlay merged over live), and it becomes the live content. The track's
  // overlay file stays put — you can keep iterating it — and the previous
  // live copy is one `git revert` away like every save.
  if (typeof payload.promote === 'string') {
    if (!TRACK_RE.test(payload.promote)) return res.status(400).json({ error: 'bad track name' });
    if (!payload.content || typeof payload.content !== 'object') return res.status(400).json({ error: 'promote needs the rendered draft content' });
    const content = { ...(await readBaseContent()), ...payload.content };
    delete content._track_note;
    content.updatedAt = new Date().toISOString();
    content.updatedBy = verifiedEmail;
    content.promotedFrom = payload.promote;
    const gh = await commitToGitHub(content, verifiedEmail, null);
    if (!gh.ok) return res.status(gh.status || 500).json({ error: gh.error });
    const hook = process.env.CMS_DEPLOY_HOOK;
    if (hook) { try { await fetch(hook, { method: 'POST' }); } catch {} }
    return res.status(200).json({ ok: true, promoted: payload.promote, git: { committed: true, commit: gh.sha } });
  }

  if (!payload || typeof payload.content !== 'object') return res.status(400).json({ error: 'expected { content: {...} }' });
  // { track: "opus" } routes the save to that track's overlay file — the live
  // page is untouched. The posted content IS the full overlay (the editor sent
  // us everything it rendered), so no merge with the live base here.
  const track = typeof payload.track === 'string' && TRACK_RE.test(payload.track) ? payload.track : null;

  const content = track
    ? { ...payload.content }
    : { ...(await readBaseContent()), ...payload.content };
  content.updatedAt = new Date().toISOString();
  content.updatedBy = verifiedEmail;

  const gh = await commitToGitHub(content, verifiedEmail, track);
  if (!gh.ok) return res.status(gh.status || 500).json({ error: gh.error });

  const hook = process.env.CMS_DEPLOY_HOOK;
  let deployTriggered = false;
  if (hook) {
    try { deployTriggered = (await fetch(hook, { method: 'POST' })).ok; } catch {}
  }

  res.status(200).json({ ok: true, saved: true, git: { committed: true, commit: gh.sha }, deployTriggered });
}
