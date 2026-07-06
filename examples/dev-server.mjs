// Minimal dev server for the Plater static-site example.
// Serves the repo root (so the browser can import /packages/core/src/editor.js)
// and mounts config/content/save against the example's site.json. Dev-only:
// /api/config advertises devNoauth so the editor UI appears without auth, and
// /api/save writes to the local file instead of committing to GitHub.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // plater/ repo root
const CONTENT = path.join(ROOT, 'examples/static-site/content/site.json');
const PORT = Number(process.env.PORT || 4188);

// Point the review module at the example site (its env is read at import time).
process.env.PLATER_WEB_ROOT = process.env.PLATER_WEB_ROOT || process.env.ZMS_WEB_ROOT || path.join(ROOT, 'examples/static-site');
process.env.GITHUB_EDIT_PATH = process.env.GITHUB_EDIT_PATH || CONTENT;
process.env.PLATER_REVIEW_PATH = process.env.PLATER_REVIEW_PATH || path.join(ROOT, 'examples/static-site/.plater-review.json');
process.env.PLATER_REVIEW_WEBHOOK = process.env.PLATER_REVIEW_WEBHOOK || `http://127.0.0.1:${PORT}/dev-webhook`;
const { computeStatus, setReviewed } = await import('../packages/server-node/review.js');
const WEBHOOK_HITS = []; // dev-only: inspect at GET /dev-webhook

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  try {
    if (p === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify({ googleClientId: '', adminEmail: 'zach@thekitchen.co', editable: true, tokenAuth: false, devNoauth: true, agentRouting: false }));
    }
    if (p === '/api/content') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      return res.end(await fs.readFile(CONTENT, 'utf8').catch(() => '{}'));
    }
    if (p === '/api/agent-note' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'demo-' + Math.round(body.note ? body.note.length : 0), status: 'queued' }));
    }
    if (p === '/api/review' || p === '/plater/review-status') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
        return res.end(JSON.stringify(await computeStatus()));
      }
      if (req.method === 'POST' && p === '/api/review') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (typeof body.path !== 'string') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"expected {path, reviewed}"}'); }
        const out = await setReviewed(body.path, body.reviewed !== false, 'dev');
        if (!out.ok) { res.writeHead(out.status || 500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: out.error })); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, commit: out.commit, ...out.status }));
      }
      res.writeHead(405); return res.end('{"error":"method not allowed"}');
    }
    if (p === '/dev-webhook') {
      if (req.method === 'POST') {
        WEBHOOK_HITS.push(JSON.parse(await readBody(req) || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(WEBHOOK_HITS));
    }
    if (p === '/api/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body || typeof body.content !== 'object') { res.writeHead(400); return res.end('{"error":"expected {content}"}'); }
      const base = JSON.parse(await fs.readFile(CONTENT, 'utf8').catch(() => '{}'));
      const merged = { ...base, ...body.content, updatedAt: new Date().toISOString(), updatedBy: 'dev' };
      await fs.writeFile(CONTENT, JSON.stringify(merged, null, 2) + '\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, saved: true, git: { committed: true, commit: 'dev-local' } }));
    }

    // static: example-site pages first (so /about.html etc. resolve like a real
    // multi-page site), then repo root (so /packages/... module imports work)
    let filePath = path.join(ROOT, 'examples/static-site', p);
    if (p === '/' || p === '') filePath = path.join(ROOT, 'examples/static-site/index.html');
    let stat = await fs.stat(filePath).catch(() => null);
    if (!stat) { filePath = path.join(ROOT, p); stat = await fs.stat(filePath).catch(() => null); }
    if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + p);
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Plater demo on http://127.0.0.1:${PORT} (root=${ROOT})`));
