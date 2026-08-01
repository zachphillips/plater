// /api/review — Plater per-page review state for multi-page sites.
//
// GET  → review status for every editable page (read-only, no auth: page paths,
//        titles, reviewed booleans + counts). For external consumers (e.g. a
//        dashboard tracking review progress) also expose it at /plater/review-status
//        via a rewrite:  { "source": "/plater/review-status", "destination": "/api/review" }.
// POST → mark a page reviewed/unreviewed (auth: Google ID token OR shared edit
//        token, same as /api/save). Body: { path: "/about.html", reviewed: true }.
//        Persists .plater-review.json at the repo root via a GitHub commit,
//        like any other Plater save. Response: the fresh review status.
//
// Review file format (flat map keyed by page path):
//   { "<path>": { "reviewed_at": "<iso>", "by": "<email>", "content_hash": "<sha256>" } }
//
// A page counts as REVIEWED only while its current content hash equals the hash
// stored at review time. The hash covers the page's HTML file plus the content
// values it binds (data-bind / data-list / data-cards / data-links /
// data-bind-attr), so a later push or CMS edit to anything the page shows
// automatically flips it back to unreviewed — without edits to OTHER pages'
// content invalidating it.
//
// When the LAST unreviewed page is marked reviewed, POSTs (best-effort,
// non-fatal) to PLATER_REVIEW_WEBHOOK — the "reviewWebhook" config — so an
// external queue can clear the site's review item.
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
const GITHUB_EDIT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';
const REVIEW_PATH = process.env.PLATER_REVIEW_PATH || '.plater-review.json';
const REVIEW_WEBHOOK = process.env.PLATER_REVIEW_WEBHOOK || '';
const WEB_ROOT = process.env.PLATER_WEB_ROOT || process.env.ZMS_WEB_ROOT || '';

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
  if (t.exp && Math.floor(Date.now() / 1000) > Number(t.exp)) return { ok: false, reason: 'token expired' };
  return { ok: true, email: t.email };
}

/* ---------------- page enumeration + content hashing ---------------- */

const getByPath = (obj, p) =>
  String(p).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

async function resolveWebRoot() {
  if (WEB_ROOT) return path.resolve(process.cwd(), WEB_ROOT);
  for (const w of ['web', 'public', '.']) {
    const abs = path.resolve(process.cwd(), w);
    try { await fs.access(path.join(abs, 'index.html')); return abs; } catch {}
  }
  return path.resolve(process.cwd(), 'web');
}

async function walkHtml(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkHtml(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function pageUrl(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel;
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

// Hash the page's own bytes + only the content values THIS page binds, so an
// edit to another page's copy does not invalidate this page's review.
function contentHashFor(html, content) {
  const keys = new Set();
  for (const re of [
    /data-(?:bind|list|cards|links|bind-attr)\s*=\s*"([^"]+)"/g,
    /data-(?:bind|list|cards|links|bind-attr)\s*=\s*'([^']+)'/g,
  ]) {
    let m;
    while ((m = re.exec(html))) keys.add(m[1].split(':')[0]);
  }
  const bound = {};
  for (const k of [...keys].sort()) {
    const v = getByPath(content, k);
    if (v !== undefined) bound[k] = v;
  }
  return crypto.createHash('sha256')
    .update(html).update('\u0000')
    .update(JSON.stringify(bound))
    .digest('hex');
}

async function readContent() {
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), GITHUB_EDIT_PATH), 'utf8'));
  } catch {
    return {};
  }
}

async function listPages() {
  const root = await resolveWebRoot();
  const content = await readContent();
  const files = (await walkHtml(root)).sort();
  const pages = [];
  for (const f of files) {
    const html = await fs.readFile(f, 'utf8').catch(() => '');
    pages.push({ path: pageUrl(root, f), title: titleOf(html), content_hash: contentHashFor(html, content) });
  }
  return pages;
}

/* ---------------- review-state persistence (GitHub-first) ---------------- */

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const ghConfigured = () =>
  Boolean((process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN) && GITHUB_REPOSITORY);

// Read the review file fresh from GitHub when configured (a review mark should
// be visible immediately, without waiting for a redeploy); fall back to disk.
async function readReviewState() {
  if (ghConfigured()) {
    const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
    const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${REVIEW_PATH}`;
    try {
      const r = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders(token), cache: 'no-store' });
      if (r.ok) {
        const file = await r.json();
        const text = Buffer.from(file.content || '', 'base64').toString('utf8');
        return { state: JSON.parse(text || '{}'), sha: file.sha };
      }
      if (r.status === 404) return { state: {}, sha: undefined };
    } catch {}
  }
  try {
    return { state: JSON.parse(await fs.readFile(path.resolve(process.cwd(), REVIEW_PATH), 'utf8')), sha: undefined };
  } catch {
    return { state: {}, sha: undefined };
  }
}

async function writeReviewState(state, sha, who, pagePath, reviewed) {
  const body = JSON.stringify(state, null, 2) + '\n';
  if (!ghConfigured()) {
    // Dev / unconfigured: durable-enough local write so the flow still works.
    await fs.writeFile(path.resolve(process.cwd(), REVIEW_PATH), body);
    return { ok: true, commit: null };
  }
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${REVIEW_PATH}`;
  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `review(${SITE_NAME}): ${reviewed ? 'mark' : 'unmark'} ${pagePath} reviewed by ${who}`,
      content: Buffer.from(body).toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'Plater CMS', email: COMMIT_EMAIL },
      author: { name: who || 'Plater CMS', email: who || COMMIT_EMAIL },
    }),
  });
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 300)}` };
  const result = await put.json();
  return { ok: true, commit: result.commit?.sha };
}

/* ---------------- status + mark (exported for dev servers/tests) ---------------- */

export async function computeStatus(precomputed) {
  const pages = precomputed?.pages || await listPages();
  const state = precomputed?.state || (await readReviewState()).state;
  const out = pages.map((p) => {
    const rec = state[p.path];
    const reviewed = Boolean(rec && rec.content_hash === p.content_hash);
    return {
      path: p.path,
      title: p.title,
      reviewed,
      // stale = was reviewed once, but content changed since (needs re-review)
      stale: Boolean(rec && !reviewed),
      reviewed_at: rec?.reviewed_at || null,
      by: rec?.by || null,
      content_hash: p.content_hash,
      reviewed_hash: rec?.content_hash || null,
    };
  });
  const reviewed = out.filter((p) => p.reviewed).length;
  return {
    site: SITE_NAME,
    review_path: REVIEW_PATH,
    generated_at: new Date().toISOString(),
    pages: out,
    counts: { total: out.length, reviewed, unreviewed: out.length - reviewed },
    fully_reviewed: out.length > 0 && reviewed === out.length,
  };
}

export async function setReviewed(pagePath, reviewed, who) {
  const pages = await listPages();
  const page = pages.find((p) => p.path === pagePath);
  if (!page) return { ok: false, status: 404, error: `unknown page: ${pagePath}` };

  const { state, sha } = await readReviewState();
  const before = await computeStatus({ pages, state });

  if (reviewed) {
    state[pagePath] = { reviewed_at: new Date().toISOString(), by: who, content_hash: page.content_hash };
  } else {
    delete state[pagePath];
  }

  const write = await writeReviewState(state, sha, who, pagePath, reviewed);
  if (!write.ok) return write;

  const after = await computeStatus({ pages, state });

  // Fire the fully-reviewed webhook exactly on the transition (best-effort).
  let webhookFired = false;
  if (REVIEW_WEBHOOK && reviewed && !before.fully_reviewed && after.fully_reviewed) {
    try {
      await fetch(REVIEW_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'site_fully_reviewed',
          site: SITE_NAME,
          counts: after.counts,
          review_path: REVIEW_PATH,
          at: new Date().toISOString(),
        }),
      });
      webhookFired = true;
    } catch {}
  }

  return { ok: true, status: after, commit: write.commit, webhookFired };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-cache');
    try {
      return res.status(200).json(await computeStatus());
    } catch (e) {
      return res.status(500).json({ error: 'review status failed: ' + e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return res.status(401).json({ error: `${SIGN_IN} to review` });

  let verifiedEmail;
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) {
    verifiedEmail = ADMIN_EMAIL;
  } else {
    const verified = await verifyGoogle(auth).catch((e) => ({ ok: false, reason: e.message }));
    if (!verified.ok) {
      const reason = EDIT_TOKEN ? 'bad edit token or Google auth: ' + verified.reason : verified.reason;
      return res.status(401).json({ error: 'auth failed: ' + reason });
    }
    verifiedEmail = verified.email;
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  if (!payload || typeof payload.path !== 'string') return res.status(400).json({ error: 'expected { path, reviewed }' });

  const result = await setReviewed(payload.path, payload.reviewed !== false, verifiedEmail);
  if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
  return res.status(200).json({ ok: true, commit: result.commit, ...result.status });
}
