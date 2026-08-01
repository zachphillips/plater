// GET/POST /api/versions — INTENTIONAL page versions ("tracks"), not commits.
//
// Git already remembers every save; that history is forensic, not editorial.
// This is the editorial layer: a small set of NAMED tracks per page — whole
// alternate drafts a human compares and chooses between. Canonical layout,
// inside the content dir so Vercel's includeFiles already ships it:
//
//   web/content/versions/<track>/<page-slug>.md
//
// where <page-slug> is the page path with '/' → '__' ('/' itself → 'index',
// '/tools/phone/' → 'tools__phone'). A track is anything: 'gpt56', 'opus',
// 'v2-launch', 'shorter'. Tracks are created by writing a file — no registry.
//
// Draft file format: optional YAML front matter (title, source, generated_at,
// notes) + markdown/plain body. Drafts are DOCUMENTS, deliberately decoupled
// from data-bind keys: a draft is for reading and choosing, and the accepted
// draft is applied via the normal editing paths (inline edit, /api/save, or
// an agent note "apply the <track> draft of this page").
//
// GET  /api/versions                     → { tracks: { <track>: [slugs] } }
// GET  /api/versions?track=t             → { track, pages: [{slug, path, title, …meta}] }
// GET  /api/versions?track=t&page=/x/    → the draft { …meta, body } (404 if none)
// POST /api/versions (auth like save)    → write a draft:
//        { track, page, body, meta? } — commits via GitHub like any save.
//
// NEVER destructive: writing a draft touches only its own file; the live page
// and other tracks are untouched.
import fs from 'node:fs/promises';
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
// versions live next to the content file: web/content/versions/
const VERSIONS_DIR = path.join(path.dirname(CONTENT_PATH), 'versions');

const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function slugForPage(p) {
  let out = String(p || '/').trim();
  out = out.replace(/^\/+|\/+$/g, '').replace(/\.html$/i, '').replace(/\//g, '__');
  return out || 'index';
}

export function pageForSlug(slug) {
  if (slug === 'index') return '/';
  return '/' + String(slug).replace(/__/g, '/') + '/';
}

export function parseDraft(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

export function serializeDraft(meta, body) {
  const lines = Object.entries(meta || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`);
  return (lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '') + String(body).replace(/\s*$/, '\n');
}

/* ---------------- auth (same contract as save.js) ---------------- */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogle(idToken) {
  // Fail CLOSED: with no CMS_ADMIN_EMAIL configured there is no one to
  // authorize, so an empty allowlist must never match an empty token email.
  if (!ADMIN_EMAIL) return { ok: false };
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return { ok: false };
  const t = await r.json();
  if (GOOGLE_CLIENT_ID && t.aud !== GOOGLE_CLIENT_ID) return { ok: false };
  if (String(t.email_verified) !== 'true') return { ok: false };
  if ((t.email || '').toLowerCase() !== ADMIN_EMAIL) return { ok: false };
  if (t.exp && Math.floor(Date.now() / 1000) > Number(t.exp)) return { ok: false };
  return { ok: true, email: t.email };
}

/* ---------------- read side (local disk — deployed with the site) --------- */

async function listTracks() {
  const root = path.resolve(process.cwd(), VERSIONS_DIR);
  const out = {};
  const tracks = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const t of tracks) {
    if (!t.isDirectory() || !TRACK_RE.test(t.name)) continue;
    const files = await fs.readdir(path.join(root, t.name)).catch(() => []);
    out[t.name] = files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  }
  return out;
}

async function readDraft(track, slug) {
  const file = path.resolve(process.cwd(), VERSIONS_DIR, track, slug + '.md');
  const root = path.resolve(process.cwd(), VERSIONS_DIR);
  if (!file.startsWith(root)) return null;
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text == null) return null;
  const { meta, body } = parseDraft(text);
  return { track, slug, page: pageForSlug(slug), ...meta, body };
}

/* ---------------- write side (GitHub commit, like save.js) ---------------- */

async function commitDraft(track, slug, text, who) {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token || !GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN/GITHUB_REPOSITORY' };
  const rel = path.posix.join(path.posix.dirname(CONTENT_PATH.split(path.sep).join('/')), 'versions', track, slug + '.md');
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${rel}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let sha;
  const get = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers, cache: 'no-store' });
  if (get.ok) sha = (await get.json()).sha;
  else if (get.status !== 404) return { ok: false, status: 502, error: `github read ${get.status}` };
  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `draft(${SITE_NAME}): ${track} version of ${pageForSlug(slug)} by ${who}`,
      content: Buffer.from(text).toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'Plater CMS', email: COMMIT_EMAIL },
      author: { name: who || 'Plater CMS', email: who || COMMIT_EMAIL },
    }),
  });
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 200)}` };
  return { ok: true, commit: (await put.json()).commit?.sha, path: rel };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-cache');
    const track = String(req.query?.track || '');
    const page = String(req.query?.page || '');
    try {
      if (!track) return res.status(200).json({ site: SITE_NAME, tracks: await listTracks() });
      if (!TRACK_RE.test(track)) return res.status(400).json({ error: 'bad track name' });
      if (!page) {
        const tracks = await listTracks();
        const slugs = tracks[track] || [];
        const pages = [];
        for (const s of slugs) {
          const d = await readDraft(track, s);
          if (d) { const { body, ...meta } = d; pages.push(meta); }
        }
        return res.status(200).json({ track, pages });
      }
      const draft = await readDraft(track, slugForPage(page));
      return draft ? res.status(200).json(draft) : res.status(404).json({ error: `no ${track} draft for ${page}` });
    } catch (e) {
      return res.status(500).json({ error: 'versions read failed: ' + e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return res.status(401).json({ error: `${SIGN_IN} to save a draft` });
  let who;
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) who = ADMIN_EMAIL;
  else {
    const v = await verifyGoogle(auth).catch(() => ({ ok: false }));
    if (!v.ok) return res.status(401).json({ error: 'auth failed' });
    who = v.email;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const track = String(body.track || '');
  if (!TRACK_RE.test(track)) return res.status(400).json({ error: 'bad track name (a-z0-9._-, ≤64)' });
  if (!body.page || typeof body.body !== 'string' || !body.body.trim()) {
    return res.status(400).json({ error: 'expected { track, page, body, meta? }' });
  }
  const slug = slugForPage(body.page);
  const text = serializeDraft({ page: pageForSlug(slug), ...(body.meta || {}) }, body.body);
  const out = await commitDraft(track, slug, text, who);
  if (!out.ok) return res.status(out.status || 500).json({ error: out.error });
  return res.status(200).json({ ok: true, track, slug, commit: out.commit, path: out.path });
}
