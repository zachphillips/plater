// plater dev [siteDir] — the LOCAL leg of the local → staging → prod ladder.
//
// Serves ANY Plater site from disk with the full API surface mounted against
// local files: no auth (devNoauth), no GitHub, no Vercel. Saves write straight
// to the site's site.json on disk; review marks write .plater-review.json;
// feeds/sitemap/manifest/404 run the SAME handlers production runs, so what
// you see locally is what deploys.
//
//   local    plater dev .          edit at http://127.0.0.1:4188/?edit — saves
//                                  are plain file writes; commit when happy
//   staging  git push <branch>     Vercel builds a preview URL per branch;
//                                  agent notes default to output:pr = staging
//   prod     merge to main         Vercel production; CMS saves commit to main
//
// Dev-only: /api/agent-note echoes instead of contacting the agent host, so
// a local session can never fire real agent jobs by accident.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages');
// Works both ways: `node cli/dev.mjs [dir]` and `plater dev [dir]` (where
// argv[2] is the literal subcommand "dev").
const argDir = process.argv[2] === 'dev' ? process.argv[3] : process.argv[2];
const siteDir = path.resolve(argDir || '.');
const PORT = Number(process.env.PORT || 4188);

function findWebRoot(dir) {
  for (const w of ['web', 'public', '.']) {
    try { require('node:fs').accessSync(path.join(dir, w, 'index.html')); return path.join(dir, w); } catch {}
  }
  return path.join(dir, 'web');
}
const require = (await import('node:module')).createRequire(import.meta.url);
const webRoot = findWebRoot(siteDir);
const contentPath = process.env.GITHUB_EDIT_PATH
  ? path.resolve(siteDir, process.env.GITHUB_EDIT_PATH)
  : path.join(webRoot, 'content', 'site.json');

// The production handlers read env at import time — point them at this site
// BEFORE importing. This is the whole trick: same code, local backing store.
process.env.PLATER_WEB_ROOT = webRoot;
process.env.GITHUB_EDIT_PATH = path.relative(process.cwd(), contentPath);
process.env.PLATER_REVIEW_PATH = process.env.PLATER_REVIEW_PATH || path.join(siteDir, '.plater-review.json');
process.env.CMS_SITE_NAME = process.env.CMS_SITE_NAME || path.basename(siteDir);
delete process.env.GITHUB_TOKEN; // belt & braces: dev must never commit

const review = await import(path.join(PKG, 'server-node/review.js'));
const feed = await import(path.join(PKG, 'server-node/feed.js'));
const sitemap = await import(path.join(PKG, 'server-node/sitemap.js'));
const route = await import(path.join(PKG, 'server-node/route.js'));
const manifest = await import(path.join(PKG, 'server-node/manifest.js'));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Adapt node req/res to the (req, res) express-ish shape the handlers use.
function shim(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const r = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(c) { res.statusCode = c; return r; },
    json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return r; },
    send(b) { res.end(b); return r; },
    end() { res.end(); return r; },
  };
  return [{ method: req.method, url: req.url, query: q, headers: req.headers, body: undefined }, r];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify({ googleClientId: '', adminEmail: 'dev@localhost', editable: true, tokenAuth: false, devNoauth: true, agentRouting: false }));
    }
    if (p === '/api/content') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      return res.end(await fs.readFile(contentPath, 'utf8').catch(() => '{}'));
    }
    if (p === '/api/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body || typeof body.content !== 'object') { res.writeHead(400); return res.end('{"error":"expected { content: {...} }"}'); }
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

    // static files from the web root, plater packages for module imports
    let file = p.startsWith('/packages/') ? path.join(PKG, '..', p) : path.join(webRoot, p === '/' ? 'index.html' : p);
    if (!file.startsWith(path.join(PKG, '..')) && !file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
    try {
      let stat = await fs.stat(file).catch(() => null);
      if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = await fs.stat(file).catch(() => null); }
      if (!stat) throw new Error('miss');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      return res.end(await fs.readFile(file));
    } catch {
      // the same content-editable 404 + redirects production serves
      const [rq, rs] = shim(req, res, url);
      return route.default(rq, rs);
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`plater dev · ${path.basename(siteDir)}`);
  console.log(`  edit    http://127.0.0.1:${PORT}/?edit   (devNoauth — no token needed)`);
  console.log(`  feeds   http://127.0.0.1:${PORT}/feed.xml · /feed.json · /sitemap.xml · /llms.txt`);
  console.log(`  saves   → ${path.relative(siteDir, contentPath)} on disk (commit when happy)`);
  console.log(`  ladder  local (this) → staging (push branch → Vercel preview) → prod (merge to main)`);
});
