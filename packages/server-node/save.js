// POST /api/save — verifies admin auth (Google ID token OR shared edit token),
// merges the posted content, and commits it to GitHub via the Contents API.
// Read-only by default: no token/credentials → no write. Extracted verbatim
// from the reference implementation Plater was extracted from.
//
// Concurrent saves: two editors (or an editor and an agent) can commit between
// our read and our write. GitHub answers that with 409 (or 422 sha mismatch);
// we refetch the sha AND the current file, re-apply the client's patch over
// that fresh base, and retry ONCE. A second conflict is reported honestly as
// 409 { error: 'conflict' } rather than resolved by clobbering someone.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || '').toLowerCase();
// Commits need a valid git identity even when the shared edit token (which
// carries no email) is the credential used.
const COMMIT_EMAIL = ADMIN_EMAIL || 'plater@users.noreply.github.com';
const SIGN_IN = ADMIN_EMAIL ? `sign in as ${ADMIN_EMAIL}` : 'sign in with the authorized account';
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

// GitHub rejects a write whose `sha` is no longer HEAD: 409 outright, or 422
// with a "does not match" / sha complaint. Both mean the same thing — someone
// committed between our read and our write.
function isConflict(status, text) {
  return status === 409 || (status === 422 && /sha|does not match|is at/i.test(text));
}

// `rebuild(freshBase)` re-applies the client's patch over whatever is on
// GitHub NOW, so the retry after a conflict merges instead of clobbering the
// commit that beat us. If the fresh base can't be read back as an object we
// refuse to retry rather than blind-write the winner's commit away.
async function commitToGitHub(content, who, track, rebuild) {
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

  // Current sha + current decoded content in one read. 404 = file not created yet.
  async function readCurrent() {
    const get = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers, cache: 'no-store' });
    if (get.status === 404) return { sha: undefined, base: {} };
    if (!get.ok) return { error: `github read ${get.status}: ${(await get.text()).slice(0, 300)}` };
    const file = await get.json();
    let base = null;
    // Files over 1 MB come back with encoding "none" and no content — then we
    // have no base to merge and must not pretend it is empty.
    if (file.encoding === 'base64' && typeof file.content === 'string') {
      try { base = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch { base = null; }
    }
    return { sha: file.sha, base };
  }

  const message = track
    ? `draft(${SITE_NAME}): ${track} track edit via CMS by ${who}`
    : `content(${SITE_NAME}): edit via CMS by ${who}`;
  const put = (value, sha) => fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(stableJson(value)).toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'Plater CMS', email: COMMIT_EMAIL },
      author: { name: who || 'Plater CMS', email: who || COMMIT_EMAIL },
    }),
  });

  const current = await readCurrent();
  if (current.error) return { ok: false, status: 502, error: current.error };

  const first = await put(content, current.sha);
  if (first.ok) return { ok: true, sha: (await first.json()).commit?.sha };
  const firstText = await first.text();
  if (!isConflict(first.status, firstText)) {
    return { ok: false, status: 502, error: `github write ${first.status}: ${firstText.slice(0, 300)}` };
  }

  // Exactly one refetch-and-retry. A second conflict is a real race the human
  // has to resolve by reloading — silently looping would keep overwriting them.
  const fresh = await readCurrent();
  if (fresh.error) return { ok: false, status: 502, error: fresh.error };
  // No usable fresh base (>1 MB inline-less response, or unparseable JSON) means
  // we cannot merge — report the conflict instead of overwriting the other save.
  const mergeable = fresh.base && typeof fresh.base === 'object' && !Array.isArray(fresh.base);
  if (!mergeable) return { ok: false, status: 409, conflict: true, error: 'conflict' };
  const second = await put(rebuild ? rebuild(fresh.base) : content, fresh.sha);
  if (second.ok) return { ok: true, sha: (await second.json()).commit?.sha };
  const secondText = await second.text();
  if (isConflict(second.status, secondText)) return { ok: false, status: 409, conflict: true, error: 'conflict' };
  return { ok: false, status: 502, error: `github write ${second.status}: ${secondText.slice(0, 300)}` };
}

const CONFLICT_MESSAGE = 'Someone else saved this content a moment ago — reload to see the latest before saving again.';

function failed(res, gh) {
  if (gh.conflict) return res.status(409).json({ error: 'conflict', message: CONFLICT_MESSAGE });
  return res.status(gh.status || 500).json({ error: gh.error });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return res.status(401).json({ error: `${SIGN_IN} to save` });

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

  let payload;
  try { payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
  catch { return res.status(400).json({ error: 'invalid JSON body' }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ error: 'expected { content: {...} }' });
  const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
  if (payload.track != null && payload.track !== '' && (typeof payload.track !== 'string' || !TRACK_RE.test(payload.track))) {
    return res.status(400).json({ error: 'Invalid track name' });
  }

  // { promote: "opus" } — MAKE THIS DRAFT LIVE, one click, no agent. The
  // client sends the draft content it is currently rendering (already the
  // overlay merged over live), and it becomes the live content. The track's
  // overlay file stays put — you can keep iterating it — and the previous
  // live copy is one `git revert` away like every save.
  if (typeof payload.promote === 'string') {
    if (!TRACK_RE.test(payload.promote)) return res.status(400).json({ error: 'bad track name' });
    if (!payload.content || typeof payload.content !== 'object') return res.status(400).json({ error: 'promote needs the rendered draft content' });
    // The patch (the rendered draft) re-applied over any base — disk now, or
    // GitHub's fresher copy if the first write loses a race.
    const promoted = (base) => {
      const out = { ...base, ...payload.content };
      delete out._track_note;
      out.updatedAt = new Date().toISOString();
      out.updatedBy = verifiedEmail;
      out.promotedFrom = payload.promote;
      return out;
    };
    const gh = await commitToGitHub(promoted(await readBaseContent()), verifiedEmail, null, promoted);
    if (!gh.ok) return failed(res, gh);
    const hook = process.env.CMS_DEPLOY_HOOK;
    if (hook) { try { await fetch(hook, { method: 'POST' }); } catch {} }
    return res.status(200).json({ ok: true, promoted: payload.promote, git: { committed: true, commit: gh.sha } });
  }

  if (!payload || typeof payload.content !== 'object') return res.status(400).json({ error: 'expected { content: {...} }' });
  // { track: "opus" } routes the save to that track's overlay file — the live
  // page is untouched. The posted content IS the full overlay (the editor sent
  // us everything it rendered), so no merge with the live base here.
  const track = typeof payload.track === 'string' && TRACK_RE.test(payload.track) ? payload.track : null;

  // The client's patch as a function of a base, so a conflict retry can re-apply
  // it over GitHub's fresher bytes. On retry the base is whatever file we are
  // writing (live content, or that track's own overlay), never the other one.
  const apply = (base) => {
    const out = { ...base, ...payload.content };
    out.updatedAt = new Date().toISOString();
    out.updatedBy = verifiedEmail;
    return out;
  };
  const gh = await commitToGitHub(apply(track ? {} : await readBaseContent()), verifiedEmail, track, apply);
  if (!gh.ok) return failed(res, gh);

  const hook = track ? null : process.env.CMS_DEPLOY_HOOK;
  let deployTriggered = false;
  if (hook) {
    try { deployTriggered = (await fetch(hook, { method: 'POST' })).ok; } catch {}
  }

  res.status(200).json({ ok: true, saved: true, git: { committed: true, commit: gh.sha }, deployTriggered });
}
