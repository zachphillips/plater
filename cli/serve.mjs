// plater serve [siteDir] — the same site, for real.
//
// `plater dev` is the local leg: no auth, saves are file writes. This is the
// PRODUCTION leg for anyone not on Vercel — a plain Node host, a VPS, a
// container, a Tailscale box. Same handlers, same routes, same rewrites
// vercel.json declares, but nothing is relaxed:
//
//   auth      real /api/config and real handlers — every write needs
//             CMS_EDIT_TOKEN or a Google ID token, and fails CLOSED when
//             neither is configured (the site serves read-only)
//   env       process.env first, then KEY=VALUE lines from <siteDir>/.env
//             for hosts that have no env UI. The host always wins.
//   binding   HOST (default 127.0.0.1 — put a TLS proxy in front, or set
//             0.0.0.0 deliberately), PORT (default 8080, autopicks upward)
//
// Saves still commit to GitHub through GITHUB_TOKEN, exactly as they do on
// Vercel, so `serve` and a Vercel deployment of the same directory behave
// identically. Everything below is dev.mjs's server kit with the dev-only
// legs (devNoauth config, echo agent-note, disk-write save) removed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shim, serveStatic, resolveSite, configureEnv, loadHandlers, listenWithAutopick } from './dev.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'packages');
// Comfortably over upload.js's own 4 MB image limit once base64 has inflated
// it; anything larger is refused before it is buffered.
const MAX_BODY = 6 * 1024 * 1024;

/* ---------------- .env ---------------- */

// A deliberately dumb dotenv: KEY=VALUE lines, # comments, no quoting, no
// expansion, no multi-line values. It exists so a bare Node host can hold its
// config in a file; it is not a config language, and process.env always wins so
// a stale .env can never override what the host actually set. Returns the keys
// it applied (names only — never log a value).
export function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const applied = [];
  for (const line of text.split('\n')) {
    const s = line.trim().replace(/^export\s+/, '');
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    // A ` #` after whitespace is a trailing comment — .env.example ships them,
    // and copying it to .env is the expected first move. A '#' inside a value
    // (no leading space) is kept.
    process.env[key] = s.slice(eq + 1).replace(/\s+#.*$/, '').trim();
    applied.push(key);
  }
  return applied;
}

/* ---------------- handlers ---------------- */

// dev.mjs loads the handlers dev needs; production needs the authenticated ones
// too. Dynamic for the same reason: configureEnv() must win the race with their
// module bodies, which read env at import time.
async function loadAuthHandlers() {
  const names = ['config.js', 'save.js', 'history.js', 'agent-note.js', 'propose-post.js'];
  const mods = await Promise.all(names.map((n) => import(path.join(PKG, 'server-node', n))));
  const [config, save, history, agentNote, proposePost] = mods;
  return { config, save, history, 'agent-note': agentNote, 'propose-post': proposePost };
}

/* ---------------- request body ---------------- */

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Bounded read: `serve` faces the network, so the cap is enforced against the
// stream, not just the (omittable, lie-able) content-length header. Returns
// null after answering the request itself.
async function readCapped(req, res) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) { json(res, 413, { error: 'payload too large' }); return null; }
  const chunks = [];
  let seen = 0;
  for await (const c of req) {
    seen += c.length;
    if (seen > MAX_BODY) { json(res, 413, { error: 'payload too large' }); req.destroy(); return null; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------------- the server ---------------- */

export function createServeServer({ webRoot, handlers }) {
  const { content, review, feed, sitemap, route, manifest, versions, upload, config, save, history } = handlers;
  const API = {
    config, content, save, history, upload, review, versions, feed, sitemap, manifest,
    'agent-note': handlers['agent-note'], 'propose-post': handlers['propose-post'],
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      // The vercel.json rewrites, served by hand so a Node host matches Vercel.
      if (p === '/feed.xml') { const [rq, rs] = shim(req, res, new URL('/api/feed?format=rss', 'http://x')); return feed.default(rq, rs); }
      if (p === '/feed.json') { const [rq, rs] = shim(req, res, new URL('/api/feed?format=json', 'http://x')); return feed.default(rq, rs); }
      if (p === '/sitemap.xml') { const [rq, rs] = shim(req, res, url); return sitemap.default(rq, rs); }
      if (p === '/llms.txt') { const [rq, rs] = shim(req, res, new URL('/api/manifest?format=llms', 'http://x')); return manifest.default(rq, rs); }
      if (p === '/.well-known/plater.json') { const [rq, rs] = shim(req, res, url); return manifest.default(rq, rs); }
      if (p === '/plater/review-status') { const [rq, rs] = shim(req, res, url); return review.default(rq, rs); }

      // /api/<name> → the file Vercel would have made a function. Every one of
      // these does its own auth; nothing here decides who may write.
      const mod = p.startsWith('/api/') && Object.prototype.hasOwnProperty.call(API, p.slice(5)) ? API[p.slice(5)] : null;
      if (mod) {
        let body;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const raw = await readCapped(req, res);
          if (raw === null) return; // already answered (413)
          // Vercel hands handlers a parsed object; match that, and answer a
          // malformed body with 400 rather than letting it surface as a 500.
          if (raw) {
            try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
          }
        }
        const [rq, rs] = shim(req, res, url, body);
        return mod.default(rq, rs);
      }

      // Static files from the web root. repoRoot is pinned to the web root on
      // purpose: dev serves /packages/* out of the Plater checkout so the
      // browser can import un-vendored modules, and production must never
      // expose a directory outside the site.
      //
      // Dotfiles are never assets. A flat starter's web root IS the project
      // dir, so .env (GITHUB_TOKEN!), .git/, .env.example and
      // .plater-review.json all sit under it — serving them would hand out the
      // repo's credentials. .well-known is the one real exception (ACME).
      // Blocked paths fall through to the ordinary 404 rather than a 403, so
      // the response never confirms which files exist.
      const dotted = p.split('/').some((seg) => seg.startsWith('.') && seg !== '.well-known');
      if (!dotted && await serveStatic(req, res, p, { webRoot, repoRoot: webRoot })) return;

      // Nothing matched → redirects-as-content, then the editable 404.
      const [rq, rs] = shim(req, res, url);
      return route.default(rq, rs);
    } catch (e) {
      // Never leak a stack or an env value to the network.
      console.error(`plater serve: ${req.method} ${p} — ${e.stack || e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}

// Resolve → .env → configure env → load handlers → build → listen (autopick).
export async function startServe(argDir, { port = 8080, host = '127.0.0.1' } = {}) {
  const siteDir = path.resolve(argDir || '.');
  // Before resolveSite: .env may be where GITHUB_EDIT_PATH lives.
  const envKeys = loadEnvFile(path.join(siteDir, '.env'));
  const site = resolveSite(siteDir);
  configureEnv(site, { dev: false });
  const handlers = { ...(await loadHandlers()), ...(await loadAuthHandlers()) };
  const server = createServeServer({ ...site, handlers });
  const chosen = await listenWithAutopick(server, { port, host });
  return { ...site, server, port: chosen, host, envKeys };
}

/* ---------------- cli ---------------- */

async function main() {
  const argDir = process.argv[2] === 'serve' ? process.argv[3] : process.argv[2];
  const asked = Number(process.env.PORT);
  const wanted = Number.isInteger(asked) && asked > 0 ? asked : 8080;
  const host = process.env.HOST || '127.0.0.1';

  let out;
  try {
    out = await startServe(argDir, { port: wanted, host });
  } catch (e) {
    if (e.friendly) { console.error(e.message); process.exit(1); }
    throw e;
  }

  const { siteDir, contentPath, port, envKeys } = out;
  const auth = [process.env.GOOGLE_CLIENT_ID && 'Google SSO', process.env.CMS_EDIT_TOKEN && 'edit token'].filter(Boolean);
  console.log(`plater serve · ${path.basename(siteDir)}`);
  if (port !== wanted) console.log(`  port    ${wanted} was busy — serving on ${port}`);
  // 0.0.0.0 is a bind address, not somewhere you can click to.
  console.log(`  url     http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}/`);
  if (envKeys.length) console.log(`  env     ${envKeys.length} key(s) from .env: ${envKeys.join(', ')}`);
  console.log(`  auth    ${auth.length ? auth.join(' + ') + ' — editors sign in at /?edit' : 'NONE configured — the site is read-only (set CMS_EDIT_TOKEN or GOOGLE_CLIENT_ID)'}`);
  console.log(`  saves   ${process.env.GITHUB_TOKEN ? `commit to ${process.env.GITHUB_REPOSITORY || '(GITHUB_REPOSITORY unset!)'}@${process.env.GITHUB_BRANCH || 'main'}` : 'DISABLED — no GITHUB_TOKEN, so writes 501'}`);
  console.log(`  content ${path.relative(siteDir, contentPath)}`);
  if (host === '127.0.0.1') console.log(`  note    bound to loopback — set HOST=0.0.0.0 to accept outside traffic, behind TLS`);
}

// Entry two ways: `node cli/serve.mjs [dir]` and `plater serve [dir]`.
const entry = (() => {
  try { return fs.realpathSync(process.argv[1] || ''); } catch { return ''; }
})();
const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
if (entry === SELF || (path.dirname(entry) === path.dirname(SELF) && /^(plater|zms)\.js$/.test(path.basename(entry)) && process.argv[2] === 'serve')) {
  await main();
}
