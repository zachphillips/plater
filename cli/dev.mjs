// plater dev [siteDir] — the LOCAL leg of the local → staging → prod ladder.
//
// Serves ANY Plater site from disk with the full API surface mounted against
// local files: no auth (devNoauth), no GitHub, no Vercel. Saves write straight
// to the site's site.json on disk; review marks write .plater-review.json;
// history reads real `git log`; image uploads land in the web root; feeds/
// sitemap/manifest/404 run the SAME handlers production runs, so what you see
// locally is what deploys.
//
//   local    plater dev .          edit at http://127.0.0.1:4188/?edit — saves
//                                  are plain file writes; commit when happy
//   staging  git push <branch>     Vercel builds a preview URL per branch;
//                                  agent notes default to output:pr = staging
//   prod     merge to main         Vercel production; CMS saves commit to main
//
// Dev-only: /api/agent-note echoes instead of contacting the agent host, so
// a local session can never fire real agent jobs by accident.
//
// Everything here is also the reusable server kit for cli/serve.mjs: TYPES,
// readBody, shim, serveStatic, findWebRoot, resolveSite, configureEnv,
// loadHandlers, listenWithAutopick, createDevServer, startDev.
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'packages');
const REPO_ROOT = path.resolve(PKG, '..');
const exec = promisify(execFile);

export const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2' };

export function findWebRoot(dir) {
  for (const w of ['web', 'public', '.']) {
    try { fsSync.accessSync(path.join(dir, w, 'index.html')); return path.join(dir, w); } catch {}
  }
  return path.join(dir, 'web');
}

// A site dir → the three paths every leg of the server needs.
export function resolveSite(argDir) {
  const siteDir = path.resolve(argDir || '.');
  const webRoot = findWebRoot(siteDir);
  const contentPath = process.env.GITHUB_EDIT_PATH
    ? path.resolve(siteDir, process.env.GITHUB_EDIT_PATH)
    : path.join(webRoot, 'content', 'site.json');
  return { siteDir, webRoot, contentPath };
}

// The production handlers read env at IMPORT time — point them at this site
// before loadHandlers(). This is the whole trick: same code, local backing store.
// `dev` also drops GITHUB_TOKEN so a local session can never commit.
export function configureEnv({ siteDir, webRoot, contentPath }, { dev = true } = {}) {
  process.env.PLATER_WEB_ROOT = webRoot;
  process.env.GITHUB_EDIT_PATH = path.relative(process.cwd(), contentPath);
  process.env.PLATER_REVIEW_PATH = process.env.PLATER_REVIEW_PATH || path.join(siteDir, '.plater-review.json');
  process.env.CMS_SITE_NAME = process.env.CMS_SITE_NAME || path.basename(siteDir);
  if (dev) delete process.env.GITHUB_TOKEN; // belt & braces: dev must never commit
}

// Dynamic, because configureEnv() has to win the race with their module bodies.
export async function loadHandlers() {
  const load = (n) => import(path.join(PKG, 'server-node', n));
  const [content, review, feed, sitemap, route, manifest, versions, upload] = await Promise.all(
    ['content.js', 'review.js', 'feed.js', 'sitemap.js', 'route.js', 'manifest.js', 'versions.js', 'upload.js'].map(load),
  );
  return { content, review, feed, sitemap, route, manifest, versions, upload };
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Adapt node req/res to the (req, res) express-ish shape the handlers use.
export function shim(req, res, url, body) {
  const q = Object.fromEntries(url.searchParams);
  const r = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(c) { res.statusCode = c; return r; },
    json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return r; },
    send(b) { res.end(b); return r; },
    end() { res.end(); return r; },
  };
  return [{ method: req.method, url: req.url, query: q, headers: req.headers, body }, r];
}

// Static files from the web root, plus /packages/* from the repo so the browser
// can import the un-vendored client modules. Returns true when it answered.
export async function serveStatic(req, res, pathname, { webRoot, repoRoot = REPO_ROOT }) {
  const fromPackages = pathname.startsWith('/packages/');
  const root = fromPackages ? repoRoot : webRoot;
  let file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  // path.join normalises "..", so this prefix check is what stops traversal.
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return true; }
  let stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = await fs.stat(file).catch(() => null); }
  if (!stat?.isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(await fs.readFile(file));
  return true;
}

/* ---------------- port autopick ---------------- */

// listen(port); on EADDRINUSE walk up to port+span. Resolves with the port that
// took. When every port in the range is busy it rejects with an error carrying
// `.friendly` — one human line, no stack, for the caller to print before exit.
export function listenWithAutopick(server, { port, host = '127.0.0.1', span = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let candidate = port;
    const onError = (err) => {
      if (err.code !== 'EADDRINUSE') { cleanup(); reject(err); return; }
      if (candidate >= port + span) {
        cleanup();
        const e = new Error(`ports ${port}-${port + span} are all busy — set PORT=<free port> to choose one yourself`);
        e.friendly = true;
        reject(e);
        return;
      }
      server.listen(++candidate, host);
    };
    const onListening = () => { cleanup(); resolve(candidate); };
    const cleanup = () => { server.removeListener('error', onError); server.removeListener('listening', onListening); };
    server.on('error', onError);
    server.on('listening', onListening);
    server.listen(candidate, host);
  });
}

/* ---------------- dev /api/history (real git, no GitHub) ---------------- */

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const UNIT = '\x1f';
const MAX_GIT_BUFFER = 16 * 1024 * 1024;

// The git worktree the site lives in, or null when it is not in one.
async function gitRoot(dir) {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { maxBuffer: 1 << 20 });
    return stdout.trim() || null;
  } catch { return null; }
}

// Repo-relative, forward-slashed — the only shape git pathspecs and `show`
// accept. Null when the content file sits outside the worktree.
function repoRelative(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return !rel || rel.startsWith('../') ? null : rel;
}

const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// The file a history request is about: the live content, or a draft track's
// overlay — the same path /api/save writes for `{ track }`. Track-blindness
// here would make Restore-inside-?draft= rewrite the LIVE page.
function historyTarget(contentPath, track) {
  return track ? path.join(path.dirname(contentPath), 'versions', track, 'site.json') : contentPath;
}

async function handleHistory(req, res, url, { siteDir, contentPath }) {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const root = await gitRoot(siteDir);

  if (req.method === 'GET') {
    const track = url.searchParams.get('track') || '';
    if (track && !TRACK_RE.test(track)) return json(400, { error: 'bad track name' });
    const rel = root && repoRelative(root, historyTarget(contentPath, track));
    // Not a git checkout → no history to show, and that is not an error: the
    // dev contract is "saves are file writes", so an empty list is the truth.
    if (!rel) return json(200, { commits: [] });
    const asked = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 50) : 30;
    let stdout = '';
    try {
      ({ stdout } = await exec('git', ['-C', root, 'log', `--max-count=${limit}`, `--format=%H${UNIT}%an${UNIT}%aI${UNIT}%s`, '--', rel], { maxBuffer: MAX_GIT_BUFFER }));
    } catch { return json(200, { commits: [] }); } // untracked file, or an empty repo with no HEAD
    const commits = stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, author, date, ...rest] = line.split(UNIT);
      return { sha, message: rest.join(UNIT), author, date };
    });
    return json(200, { commits });
  }

  const body = JSON.parse(await readBody(req) || '{}');
  const restore = String(body?.restore || '');
  if (!SHA_RE.test(restore)) return json(400, { error: 'expected { restore: "<full sha>" }' });
  const track = typeof body?.track === 'string' ? body.track : '';
  if (track && !TRACK_RE.test(track)) return json(400, { error: 'bad track name' });
  const target = historyTarget(contentPath, track);
  const rel = root && repoRelative(root, target);
  if (!rel) return json(501, { error: 'this site is not in a git repo — there is nothing to restore from' });
  let stdout;
  try {
    ({ stdout } = await exec('git', ['-C', root, 'show', `${restore}:${rel}`], { maxBuffer: MAX_GIT_BUFFER }));
  } catch { return json(404, { error: `no ${rel} at ${restore.slice(0, 7)}` }); }
  // Fail closed on a corrupt blob: writing unparseable JSON would take the page
  // down and the only fix would be another restore.
  try { JSON.parse(stdout); } catch { return json(422, { error: `content at ${restore.slice(0, 7)} is not valid JSON` }); }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, stdout);
  // commit: null — dev never commits. The restore is on disk like every other
  // dev save, so `git diff` shows it and you commit when happy.
  return json(200, { ok: true, commit: null, ...(track ? { track } : {}) });
}

/* ---------------- dev /api/upload (writes into the web root) ---------------- */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BODY = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;

async function handleUpload(req, res, { webRoot }, safeName) {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BODY) return json(413, { error: 'image too large (4 MB max)' });

  let payload;
  try { payload = JSON.parse(await readBody(req) || '{}'); }
  catch { return json(400, { error: 'expected JSON { filename, dataBase64 }' }); }
  if (typeof payload.filename !== 'string' || typeof payload.dataBase64 !== 'string') {
    return json(400, { error: 'expected { filename, dataBase64 }' });
  }

  // A whole data: URL is fine; whitespace is legal in base64 transport.
  const b64 = payload.dataBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!b64) return json(400, { error: 'empty image' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return json(400, { error: 'dataBase64 is not base64' });
  // Reject on encoded length first — never allocate a buffer we would refuse.
  if (Math.floor(b64.length * 3 / 4) > MAX_IMAGE_BYTES) return json(413, { error: 'image too large (4 MB max)' });
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return json(400, { error: 'empty image' });
  if (buf.length > MAX_IMAGE_BYTES) return json(413, { error: 'image too large (4 MB max)' });

  // Same allowlist + hash-prefixed slug the production handler uses, imported
  // from it so dev and prod can never disagree about the final filename.
  const named = safeName(payload.filename, buf);
  if (named.error) return json(400, { error: named.error });

  const dest = path.join(webRoot, 'images', named.name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  const rel = path.relative(process.cwd(), dest).split(path.sep).join('/');
  return json(200, { ok: true, url: `/images/${named.name}`, path: rel, commit: null });
}

/* ---------------- the dev server ---------------- */

export function createDevServer({ siteDir, webRoot, contentPath, handlers }) {
  const { content, review, feed, sitemap, route, manifest, versions, upload } = handlers;
  const ctx = { siteDir, webRoot, contentPath };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/api/config') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
        return res.end(JSON.stringify({ googleClientId: '', adminEmail: 'dev@localhost', editable: true, tokenAuth: false, devNoauth: true, agentRouting: false }));
      }
      // The real handler, so ?track= overlays AND ?file= alternate content
      // files behave (and reject traversal) exactly as they do in production.
      if (p === '/api/content') { const [rq, rs] = shim(req, res, url); return content.default(rq, rs); }
      if (p === '/api/history' && (req.method === 'GET' || req.method === 'POST')) return handleHistory(req, res, url, ctx);
      if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res, ctx, upload.safeName);
      if (p === '/api/save' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body || typeof body.content !== 'object') { res.writeHead(400); return res.end('{"error":"expected { content: {...} }"}'); }
        if (typeof body.promote === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.promote)) {
          const base = JSON.parse(await fs.readFile(contentPath, 'utf8').catch(() => '{}'));
          const next = { ...base, ...body.content, updatedAt: new Date().toISOString(), updatedBy: 'dev', promotedFrom: body.promote };
          delete next._track_note;
          await fs.writeFile(contentPath, JSON.stringify(next, null, 2) + '\n');
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, promoted: body.promote, git: { committed: false, dev: 'live content replaced on disk' } }));
        }
        if (typeof body.track === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.track)) {
          const overlayPath = path.join(path.dirname(contentPath), 'versions', body.track, 'site.json');
          await fs.mkdir(path.dirname(overlayPath), { recursive: true });
          await fs.writeFile(overlayPath, JSON.stringify({ ...body.content, updatedAt: new Date().toISOString(), updatedBy: 'dev' }, null, 2) + '\n');
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, saved: true, track: body.track, git: { committed: false, dev: 'wrote draft overlay on disk' } }));
        }
        const base = JSON.parse(await fs.readFile(contentPath, 'utf8').catch(() => '{}'));
        const next = { ...base, ...body.content, updatedAt: new Date().toISOString(), updatedBy: 'dev' };
        await fs.writeFile(contentPath, JSON.stringify(next, null, 2) + '\n');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, saved: true, git: { committed: false, dev: 'wrote local file — commit when happy' } }));
      }
      if (p === '/api/agent-note' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        res.writeHead(202, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'dev-echo', status: 'queued', dev: 'agent routing is disabled in plater dev — push a branch and note the preview URL instead', note: (body.note || '').slice(0, 120) }));
      }
      if (p === '/api/review' || p === '/plater/review-status') {
        if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(await review.computeStatus())); }
        const body = JSON.parse(await readBody(req) || '{}');
        const out = await review.setReviewed(body.path, body.reviewed !== false, 'dev');
        res.writeHead(out.ok ? 200 : out.status || 500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out.ok ? { ok: true, ...out.status } : { error: out.error }));
      }
      if (p === '/feed.xml') { const [rq, rs] = shim(req, res, new URL('/api/feed?format=rss', 'http://x')); return feed.default(rq, rs); }
      if (p === '/feed.json') { const [rq, rs] = shim(req, res, new URL('/api/feed?format=json', 'http://x')); return feed.default(rq, rs); }
      if (p === '/sitemap.xml') { const [rq, rs] = shim(req, res, url); return sitemap.default(rq, rs); }
      if (p === '/llms.txt') { const [rq, rs] = shim(req, res, new URL('/api/manifest?format=llms', 'http://x')); return manifest.default(rq, rs); }
      if (p === '/api/manifest' || p === '/.well-known/plater.json') { const [rq, rs] = shim(req, res, url); return manifest.default(rq, rs); }
      if (p === '/api/versions' && req.method === 'GET') { const [rq, rs] = shim(req, res, url); return versions.default(rq, rs); }

      // static files (uploaded /images/* included — they live under the web
      // root), then the same content-editable 404 + redirects production serves
      if (await serveStatic(req, res, p, { webRoot })) return;
      const [rq, rs] = shim(req, res, url);
      return route.default(rq, rs);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
}

// Resolve → configure env → load handlers → build → listen (with autopick).
export async function startDev(argDir, { port, host = '127.0.0.1' } = {}) {
  const site = resolveSite(argDir);
  configureEnv(site);
  const handlers = await loadHandlers();
  const server = createDevServer({ ...site, handlers });
  const chosen = await listenWithAutopick(server, { port, host });
  return { ...site, server, port: chosen, host };
}

/* ---------------- cli ---------------- */

async function main() {
  // Works both ways: `node cli/dev.mjs [dir]` and `plater dev [dir]` (where
  // argv[2] is the literal subcommand "dev").
  const argDir = process.argv[2] === 'dev' ? process.argv[3] : process.argv[2];
  const asked = Number(process.env.PORT);
  const wanted = Number.isInteger(asked) && asked > 0 ? asked : 4188;

  let out;
  try {
    out = await startDev(argDir, { port: wanted });
  } catch (e) {
    // Every port in the range being busy is a configuration problem, not a
    // crash — one human line, never a stack.
    if (e.friendly) { console.error(e.message); process.exit(1); }
    throw e;
  }

  const { siteDir, contentPath, webRoot, port } = out;
  console.log(`plater dev · ${path.basename(siteDir)}`);
  if (port !== wanted) console.log(`  port    ${wanted} was busy — serving on ${port}`);
  console.log(`  edit    http://127.0.0.1:${port}/?edit   (devNoauth — no token needed)`);
  console.log(`  feeds   http://127.0.0.1:${port}/feed.xml · /feed.json · /sitemap.xml · /llms.txt`);
  console.log(`  saves   → ${path.relative(siteDir, contentPath)} on disk (commit when happy)`);
  console.log(`  history real git log of that file — Restore writes the old version back to disk`);
  console.log(`  images  drop a file on any bound <img> — uploads write to ${path.relative(siteDir, path.join(webRoot, 'images')) || 'images'}/`);
  console.log(`  ladder  local (this) → staging (push branch → Vercel preview) → prod (merge to main)`);
}

// Run as a CLI two ways: `node cli/dev.mjs [dir]` (this file IS the entry) and
// `plater dev [dir]` (cli/plater.js is the entry and imports us for effect).
// Any OTHER importer — cli/serve.mjs, a test — gets the exports and no server.
const entry = (() => {
  try { return fsSync.realpathSync(process.argv[1] || ''); } catch { return ''; }
})();
const SELF = fsSync.realpathSync(fileURLToPath(import.meta.url));
if (entry === SELF || (path.dirname(entry) === path.dirname(SELF) && /^(plater|zms)\.js$/.test(path.basename(entry)) && process.argv[2] === 'dev')) {
  await main();
}
