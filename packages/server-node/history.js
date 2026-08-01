// GET/POST /api/history — the content file's git history, and one-click restore.
//
// Every Plater save is a real commit, so "undo" already exists in git; this
// handler is the editor's window onto it. It reads the commits that touched
// GITHUB_EDIT_PATH and can put an old version back — as a NEW commit, never a
// force-push or a revert, so the timeline only ever grows.
//
//   GET  /api/history?limit=N     → { commits: [{ sha, message, author, date }] }
//                                   newest first, N ≤ 50, default 30
//   POST /api/history             → { restore: "<full sha>" }
//                                   → { ok: true, commit: "<new sha or null>" }
//
// ?track=<name> / { track } scopes BOTH legs to that draft's overlay file
// (versions/<track>/site.json — the same file save.js writes for a track).
// This is not optional polish: the editor mounts History inside ?draft= mode,
// where every other write is track-scoped, so a track-blind restore would
// clobber the live published page while the screen still shows the draft.
//
// GET is read-only but requires the SAME auth as POST: commit metadata carries
// author emails, and the history of a site's copy is not public information.
//
// Both legs need a token: with no GITHUB_TOKEN/GITHUB_REPOSITORY there is no
// history to read (the disk copy is a single snapshot), so this 501s rather
// than pretending. Auth is copied locally, not imported — every handler in this
// package stays drop-in standalone.
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
const GITHUB_EDIT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';
const MAX_BODY = 10_000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// The file this request is about: the live content, or a track's overlay —
// byte-for-byte the same path save.js writes for `{ track }`.
function editPathFor(track) {
  return track
    ? `${GITHUB_EDIT_PATH.split('/').slice(0, -1).join('/')}/versions/${track}/site.json`
    : GITHUB_EDIT_PATH;
}

/* ---------------- auth (same contract as save.js) ---------------- */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
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

async function authorize(req, verb) {
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return { ok: false, status: 401, error: `${SIGN_IN} to ${verb}` };
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) return { ok: true, email: ADMIN_EMAIL };
  const verified = await verifyGoogle(auth).catch((e) => ({ ok: false, reason: e.message }));
  if (!verified.ok) {
    const reason = EDIT_TOKEN ? 'bad edit token or Google auth: ' + verified.reason : verified.reason;
    return { ok: false, status: 401, error: 'auth failed: ' + reason };
  }
  return { ok: true, email: verified.email };
}

/* ---------------- GitHub ---------------- */

function github() {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN' };
  if (!GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_REPOSITORY' };
  return {
    ok: true,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
}

// Commits that touched the content file, newest first. GitHub already returns
// them in reverse-chronological order for a path-filtered listing.
async function listCommits(headers, limit, editPath) {
  const q = new URLSearchParams({
    path: editPath,
    sha: GITHUB_BRANCH,
    per_page: String(limit),
  });
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/commits?${q}`, { headers, cache: 'no-store' });
  if (!r.ok) return { ok: false, status: 502, error: `github read ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const raw = await r.json();
  const commits = (Array.isArray(raw) ? raw : []).map((c) => {
    const a = c.commit?.author || {};
    const date = a.date ? new Date(a.date) : null;
    return {
      sha: c.sha,
      message: c.commit?.message || '',
      // Prefer the git author identity (a CMS save records the editor's email
      // there); fall back to the GitHub login when the commit is unattributed.
      author: a.name || a.email || c.author?.login || '',
      date: date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null,
    };
  });
  return { ok: true, commits };
}

// The content file exactly as it stood at <ref>. Raw media type, so a file over
// the 1 MB base64 ceiling still comes back whole.
async function readAtRef(headers, ref, editPath) {
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${editPath}`;
  const r = await fetch(`${api}?ref=${encodeURIComponent(ref)}`, {
    headers: { ...headers, Accept: 'application/vnd.github.raw' },
    cache: 'no-store',
  });
  if (r.status === 404) return { ok: false, status: 404, error: `no ${editPath} at ${ref}` };
  if (!r.ok) return { ok: false, status: 502, error: `github read ${r.status}: ${(await r.text()).slice(0, 300)}` };
  return { ok: true, text: await r.text() };
}

// Same sha-guarded PUT as save.js: read the current blob sha, then write.
async function commitToGitHub(headers, text, message, who, editPath) {
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${editPath}`;
  let sha;
  const get = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers, cache: 'no-store' });
  if (get.ok) sha = (await get.json()).sha;
  else if (get.status !== 404) return { ok: false, status: 502, error: `github read ${get.status}: ${(await get.text()).slice(0, 300)}` };

  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(text).toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'Plater CMS', email: COMMIT_EMAIL },
      author: { name: who || 'Plater CMS', email: who || COMMIT_EMAIL },
    }),
  });
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 300)}` };
  const result = await put.json();
  // null, not undefined: restoring content byte-identical to HEAD is a no-op
  // GitHub answers without a new commit, and the client must be able to say so.
  return { ok: true, commit: result.commit?.sha || null };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Read history exposes author emails, so GET is authenticated exactly like POST.
  const who = await authorize(req, req.method === 'GET' ? 'read history' : 'restore');
  if (!who.ok) return res.status(who.status).json({ error: who.error });

  const gh = github();
  if (!gh.ok) return res.status(gh.status).json({ error: gh.error });

  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-store');
    const track = String(req.query?.track || '');
    if (track && !TRACK_RE.test(track)) return res.status(400).json({ error: 'bad track name' });
    const asked = Number(req.query?.limit);
    const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), MAX_LIMIT) : DEFAULT_LIMIT;
    const out = await listCommits(gh.headers, limit, editPathFor(track));
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    return res.status(200).json({ commits: out.commits });
  }

  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return res.status(413).json({ error: 'payload too large' });

  let payload;
  try {
    payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ error: 'expected JSON { restore: "<sha>" }' });
  }
  const restore = String(payload?.restore || '');
  if (!SHA_RE.test(restore)) return res.status(400).json({ error: 'expected { restore: "<full sha>" }' });
  const track = typeof payload?.track === 'string' ? payload.track : '';
  if (track && !TRACK_RE.test(track)) return res.status(400).json({ error: 'bad track name' });
  const editPath = editPathFor(track);

  const old = await readAtRef(gh.headers, restore, editPath);
  if (!old.ok) return res.status(old.status).json({ error: old.error });
  // Fail closed on a corrupt blob: restoring unparseable JSON would take the
  // live site down, and the only fix would be another restore.
  try { JSON.parse(old.text); } catch { return res.status(422).json({ error: `content at ${restore.slice(0, 7)} is not valid JSON` }); }

  const message = track
    ? `restore(${SITE_NAME}): ${track} draft from ${restore.slice(0, 7)} by ${who.email}`
    : `restore(${SITE_NAME}): content from ${restore.slice(0, 7)} by ${who.email}`;
  const put = await commitToGitHub(gh.headers, old.text, message, who.email, editPath);
  if (!put.ok) return res.status(put.status || 500).json({ error: put.error });

  // A draft restore changes nothing the public sees — don't spend a deploy on it.
  const hook = track ? null : process.env.CMS_DEPLOY_HOOK;
  if (hook) { try { await fetch(hook, { method: 'POST' }); } catch {} }

  return res.status(200).json({ ok: true, commit: put.commit, ...(track ? { track } : {}) });
}
