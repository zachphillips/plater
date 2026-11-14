// Hosted Plater — one Cloudflare Worker that keeps every draft an agent shares
// for review at a permanent address, with every version and every review kept.
//
//   https://plater.thekitchen.co/                     every project
//   https://plater.thekitchen.co/<project>/           the latest version, editable
//   https://plater.thekitchen.co/<project>/v<n>/      version n, exactly as it was
//   https://plater.thekitchen.co/<project>/review     the project's record: each
//                                                     version, who made it and how,
//                                                     its notes, what was reviewed
//
// STORAGE. A version is an immutable manifest {path: sha256} over content-
// addressed blobs in R2 (BLOBS, key b/<sha>), listed in D1 (DB, schema.sql).
// Nothing is overwritten: an edit, a ✎ Note result or a restore makes a new
// version. The one exception keeps the list readable: a run of page edits by
// the same person within EDIT_COALESCE_MS, on a version nobody has marked
// reviewed, updates that one "edit" version in place.
//
// THE EDITOR. Pages are ordinary Plater pages. The Worker answers the same
// /api/* calls `plater dev` does (config, content, save with conflicts, history
// with restore, review, upload, live, agent-note), so @platercms/core runs
// unchanged. A page that does not load the editor gets it injected, along with
// the ✎ Note overlay and a small version pill. Pages call /api/* and their own
// assets with absolute paths, so a request outside /<project>/ is resolved from
// its Referer; a navigation to such a path is redirected to the project URL.
//
// AUTH. Cloudflare Access sits in front of the hostname. The Worker checks the
// Access JWT itself too (signature against the team's certs, audience, issuer,
// expiry, email allowlist) and fails closed without it. /_hosted/* is the
// machine API (an Access bypass on that path only): agents publish with
// PUBLISH_TOKEN, the note runner works the queue with RUNNER_TOKEN. Tokens are
// compared in constant time.
//
// ✎ NOTES. A note is queued here. The runner (runner.mjs) on the owner's
// always-on machine claims it, runs it on the owner's ChatGPT plan through the
// agent host's plan engine, and posts the changed files back; they become the
// next version and the open tab reloads. This Worker never holds or uses the
// plan's credentials, and the runner runs only the owner's notes.
//
// Env: DB (D1), BLOBS (R2), ASSETS (the editor + capture modules), vars
// ACCESS_TEAM ("<team>.cloudflareaccess.com"), ACCESS_AUD, OWNER_EMAIL,
// ALLOWED_EMAILS (optional, comma-separated), PUBLIC_URL; secrets
// PUBLISH_TOKEN, RUNNER_TOKEN.

const RESERVED = new Set(['_hosted', 'packages', 'api', '__plater', 'robots.txt', 'favicon.ico']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA = /^[a-f0-9]{64}$/;
const EDIT_COALESCE_MS = 15 * 60_000;
const CLAIM_STALE_MS = 20 * 60_000;
const MAX_BLOB = 25 * 1024 * 1024;
const MAX_FILES = 3000;
const LIVE_MS = 90_000;
const NOTE_MAX = 4000;
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', csv: 'text/csv; charset=utf-8',
  webmanifest: 'application/manifest+json',
};
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'same-origin' };

/* ---------------- small helpers ---------------- */

const now = () => new Date().toISOString();
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...NOINDEX, ...extra } });
const text = (body, status = 200, type = 'text/plain; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store', ...NOINDEX } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeOf = (p) => TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const isHtml = (p) => /\.html?$/i.test(p);
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const b64Bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)); const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && x.length > 0;
}

// A manifest path: relative, forward slashes, no dot segments or dotfiles.
export function cleanPath(p) {
  const s = String(p || '').replace(/^\/+/, '');
  if (!s || s.length > 512 || s.includes('\\') || s.includes('\0')) return null;
  const segs = s.split('/');
  if (segs.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return null;
  return segs.join('/');
}

// "/<project>/..." or "/<project>/v<n>/..." → { project, n|null, rest } or null.
export function parseProjectPath(pathname) {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || !SLUG.test(m[1]) || RESERVED.has(m[1])) return null;
  let rest = m[2] || '';
  let n = null;
  const v = /^\/v(\d{1,6})(\/.*)?$/.exec(rest);
  if (v) { n = Number(v[1]); rest = v[2] || ''; }
  return { project: m[1], n, rest, bare: !m[2] && n === null, bareVersion: v ? !v[2] : false };
}

const pageBase = (project, n, head) => (n === null || n === head ? `/${project}/` : `/${project}/v${n}/`);

/* ---------------- Cloudflare Access ---------------- */

let certCache = { at: 0, keys: [] };
async function accessKeys(team, force = false) {
  if (!force && certCache.keys.length && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const j = await r.json();
  certCache = { at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}
export function _resetAccessCache() { certCache = { at: 0, keys: [] }; }

// Returns the signed-in email, or null. Never throws.
export async function accessUser(req, env) {
  try {
    const jwt = req.headers.get('cf-access-jwt-assertion');
    if (!jwt || !env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(p)));
    if (header.alg !== 'RS256') return null;
    let jwk = (await accessKeys(env.ACCESS_TEAM)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env.ACCESS_TEAM, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${env.ACCESS_TEAM}`) return null;
    if (!claims.exp || Date.now() / 1000 > Number(claims.exp)) return null;
    const email = String(claims.email || '').toLowerCase();
    const allowed = [env.OWNER_EMAIL, ...String(env.ALLOWED_EMAILS || '').split(',')].map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
    return allowed.includes(email) ? email : null;
  } catch { return null; }
}

/* ---------------- data access ---------------- */

const getProject = (env, slug) => env.DB.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first();
async function getVersion(env, project, n) {
  const row = await env.DB.prepare('SELECT * FROM versions WHERE project = ? AND n = ?').bind(project, n).first();
  return row ? { ...row, files: JSON.parse(row.manifest) } : null;
}
async function blobBytes(env, sha) {
  const o = await env.BLOBS.get(`b/${sha}`);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}
async function blobText(env, sha) { const b = await blobBytes(env, sha); return b ? new TextDecoder().decode(b) : null; }
async function putBlob(env, bytes) {
  const sha = await sha256(bytes);
  const known = await env.DB.prepare('SELECT sha FROM blobs WHERE sha = ?').bind(sha).first();
  if (!known) {
    await env.BLOBS.put(`b/${sha}`, bytes);
    await env.DB.prepare('INSERT OR IGNORE INTO blobs (sha, size, created_at) VALUES (?, ?, ?)').bind(sha, bytes.length, now()).run();
  }
  return sha;
}
async function readContent(env, project, version) {
  const sha = version.files[project.content_path];
  if (!sha) return {};
  try { return JSON.parse(await blobText(env, sha)); } catch { return {}; }
}

// New version n = head + 1, or (coalesce) the head "edit" version updated in place.
async function writeVersion(env, project, files, { source, by, message = null, noteId = null, coalesce = false }) {
  const head = project.head ? await getVersion(env, project.slug, project.head) : null;
  const stamp = now();
  if (coalesce && head && head.source === 'edit' && head.by === by && Date.now() - Date.parse(head.created_at) < EDIT_COALESCE_MS) {
    const reviewed = await env.DB.prepare('SELECT id FROM reviews WHERE project = ? AND version = ? AND reviewed = 1 LIMIT 1').bind(project.slug, head.n).first();
    if (!reviewed) {
      await env.DB.prepare('UPDATE versions SET manifest = ?, updated_at = ? WHERE project = ? AND n = ?').bind(JSON.stringify(files), stamp, project.slug, head.n).run();
      await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE slug = ?').bind(stamp, project.slug).run();
      return head.n;
    }
  }
  const n = (project.head || 0) + 1;
  // The WHERE head = ? guard makes two simultaneous writers fail instead of both claiming n.
  const res = await env.DB.batch([
    env.DB.prepare('INSERT INTO versions (project, n, manifest, source, by, message, note_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(project.slug, n, JSON.stringify(files), source, by, message, noteId, stamp, stamp),
    env.DB.prepare('UPDATE projects SET head = ?, updated_at = ? WHERE slug = ? AND head = ?').bind(n, stamp, project.slug, project.head || 0),
  ]);
  if (!res[1].meta || res[1].meta.changes !== 1) throw new Error('another change landed at the same moment; try again');
  project.head = n;
  return n;
}

/* ---------------- HTML injection ---------------- */

export function injectHtml(html, { project, n, head, hasEditor }) {
  const meta = '<meta name="robots" content="noindex,nofollow">';
  const boot = [
    hasEditor ? '' : `<script type="module">import { initPlater } from '/packages/core/src/editor.js'; window.__platerHosted = initPlater({ brand: 'Plater' });</script>`,
    `<script type="module" src="/__plater/notes.js" data-project="${esc(project)}" data-version="${n}" data-head="${head}"></script>`,
  ].join('');
  let out = html;
  const hi = out.search(/<\/head>/i);
  out = hi === -1 ? meta + out : out.slice(0, hi) + meta + out.slice(hi);
  const bi = out.toLowerCase().lastIndexOf('</body>');
  return bi === -1 ? out + boot : out.slice(0, bi) + boot + out.slice(bi);
}

/* ---------------- page + API routing ---------------- */

async function serveFile(env, req, ctx, rel) {
  const { project, version } = ctx;
  let path = rel.replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  let sha = version.files[path];
  if (!sha && version.files[`${path}/index.html`]) {
    const u = new URL(req.url); u.pathname = u.pathname.replace(/\/?$/, '/'); return Response.redirect(u.toString(), 302);
  }
  if (!sha && version.files[`${path}.html`]) { path = `${path}.html`; sha = version.files[path]; }
  if (!sha) return text('Not in this version of the project.', 404);
  const bytes = await blobBytes(env, sha);
  if (!bytes) return text('This file is missing from storage.', 500);
  if (isHtml(path)) {
    const html = new TextDecoder().decode(bytes);
    const hasEditor = /\/packages\/core\/src\/editor\.js|initPlater\s*\(/.test(html);
    return new Response(injectHtml(html, { project: project.slug, n: version.n, head: project.head, hasEditor }), {
      headers: { 'content-type': TYPES.html, 'cache-control': 'no-store', ...NOINDEX } });
  }
  // A version's files never change, so its exact-version URLs cache for good.
  const immutable = ctx.pinned ? 'private, max-age=31536000, immutable' : 'no-cache';
  return new Response(bytes, { headers: { 'content-type': typeOf(path), 'cache-control': immutable, etag: `"${sha}"`, ...NOINDEX } });
}

// Where an absolute /api/* or /assets/* request belongs: its Referer's project.
function fromReferer(req) {
  const ref = req.headers.get('referer');
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.host !== new URL(req.url).host) return null;
    return parseProjectPath(u.pathname);
  } catch { return null; }
}

async function loadCtx(env, parsed) {
  const project = await getProject(env, parsed.project);
  if (!project || !project.head) return null;
  const n = parsed.n ?? project.head;
  const version = await getVersion(env, project.slug, n);
  if (!version) return null;
  return { project, version, atHead: n === project.head, pinned: parsed.n !== null, base: pageBase(project.slug, parsed.n, project.head) };
}

function pagesOf(ctx) {
  return Object.keys(ctx.version.files).filter(isHtml).sort().map((p) => ({ rel: p, path: ctx.base + (p === 'index.html' ? '' : p.replace(/(^|\/)index\.html$/, '$1')) }));
}

async function pageHash(ctx, rel) {
  return sha256(new TextEncoder().encode(`${ctx.version.files[rel] || ''}:${ctx.version.files[ctx.project.content_path] || ''}`));
}

async function reviewStatus(env, ctx) {
  const rows = (await env.DB.prepare('SELECT path, hash, reviewed, at, version FROM reviews WHERE project = ? ORDER BY id').bind(ctx.project.slug).all()).results;
  const last = new Map(); for (const r of rows) last.set(r.path, r);
  const titles = {};
  const pages = [];
  for (const p of pagesOf(ctx)) {
    const html = await blobText(env, ctx.version.files[p.rel]);
    titles[p.rel] = (/<title[^>]*>([^<]*)<\/title>/i.exec(html || '') || [])[1] || p.rel;
    const hash = await pageHash(ctx, p.rel);
    const rec = last.get(p.rel);
    const reviewed = Boolean(rec && rec.reviewed && rec.hash === hash);
    pages.push({ path: p.path, title: titles[p.rel].trim(), reviewed, stale: Boolean(rec && rec.reviewed && !reviewed), reviewed_at: rec?.reviewed ? rec.at : null, content_hash: hash });
  }
  const reviewed = pages.filter((p) => p.reviewed).length;
  return { pages, counts: { total: pages.length, reviewed, unreviewed: pages.length - reviewed }, fully_reviewed: pages.length > 0 && reviewed === pages.length };
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([kk]) => kk !== 'updatedAt' && kk !== 'updatedBy').sort(([a], [b]) => (a < b ? -1 : 1))) : x));

async function api(env, req, ctx, email, sub) {
  const method = req.method;
  const body = async () => { try { return await req.json(); } catch { return null; } };
  const { project, version } = ctx;

  if (sub === 'config') {
    // Access signed the person in before the page loaded, so the latest version
    // answers devNoauth (no sign-in UI). Older versions are read-only.
    return json({ googleClientId: '', tokenAuth: false, devNoauth: ctx.atHead, adminEmail: email, editable: ctx.atHead, agentRouting: ctx.atHead,
      statusLabel: ctx.atHead ? `signed in as ${email}` : `version ${version.n} of ${project.head} (read-only)` });
  }
  if (sub === 'content' && method === 'GET') {
    if (new URL(req.url).searchParams.has('track')) return json({ error: 'no draft tracks here' }, 404);
    return json(await readContent(env, project, version));
  }
  // Named draft tracks are a git-backed feature; here every version is on the review page.
  if (sub === 'versions') return json({ tracks: null });
  if (sub === 'review' && method === 'GET') return json(await reviewStatus(env, ctx));
  if (sub === 'review' && method === 'POST') {
    const b = await body();
    const page = pagesOf(ctx).find((p) => p.path === String(b?.path || '') || p.path === ctx.base + String(b?.path || '').replace(/^\//, ''));
    if (!page) return json({ error: 'no such page in this version' }, 400);
    await env.DB.prepare('INSERT INTO reviews (project, version, path, hash, reviewed, email, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(project.slug, version.n, page.rel, await pageHash(ctx, page.rel), b.reviewed === false ? 0 : 1, email, now()).run();
    return json(await reviewStatus(env, ctx));
  }
  if (sub === 'history' && method === 'GET') {
    const rows = (await env.DB.prepare('SELECT n, source, by, message, created_at, updated_at FROM versions WHERE project = ? ORDER BY n DESC LIMIT 60').bind(project.slug).all()).results;
    return json({ commits: rows.map((r) => ({ sha: `v${r.n}`, message: `v${r.n} · ${sourceLabel(r.source)}${r.message ? ` — ${r.message}` : ''}`, date: r.updated_at, author: r.by || '' })) });
  }

  if (method !== 'GET' && !ctx.atHead) return json({ error: `this is version ${version.n}; edits go to the latest version` }, 409);

  if (sub === 'save' && method === 'POST') {
    const b = await body();
    if (!b || typeof b.content !== 'object' || Array.isArray(b.content) || b.content === null) return json({ error: 'expected { content }' }, 400);
    if (b.track || b.promote) return json({ error: 'no draft tracks here' }, 400);
    const current = await readContent(env, project, version);
    if (b.base && typeof b.base === 'object' && canon(b.base) !== canon(current)) return json({ error: 'conflict', message: 'the page changed since you loaded it', content: current }, 409);
    const next = { ...b.content, updatedAt: now(), updatedBy: email };
    const files = { ...version.files, [project.content_path]: await putBlob(env, new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n')) };
    const n = await writeVersion(env, project, files, { source: 'edit', by: email, coalesce: true });
    return json({ ok: true, saved: true, version: n, content: next, git: { committed: true, commit: `v${n}` } });
  }
  if (sub === 'history' && method === 'POST') {
    const b = await body();
    const m = /^v(\d+)$/.exec(String(b?.restore || ''));
    const from = m && await getVersion(env, project.slug, Number(m[1]));
    if (!from) return json({ error: 'no such version' }, 404);
    const sha = from.files[project.content_path];
    const files = { ...version.files };
    if (sha) files[project.content_path] = sha; else delete files[project.content_path];
    const n = await writeVersion(env, project, files, { source: 'restore', by: email, message: `copy restored from v${from.n}` });
    return json({ ok: true, version: n });
  }
  if (sub === 'upload' && method === 'POST') {
    const b = await body();
    const name = String(b?.filename || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80);
    if (!name || !/\.(png|jpe?g|gif|webp|avif|svg)$/.test(name) || typeof b.dataBase64 !== 'string') return json({ error: 'expected an image file' }, 400);
    let bytes; try { bytes = b64Bytes(b.dataBase64); } catch { return json({ error: 'the image data is not base64' }, 400); }
    if (bytes.length > MAX_BLOB) return json({ error: 'image too large' }, 413);
    let rel = `images/${name}`;
    for (let i = 2; version.files[rel]; i++) rel = `images/${name.replace(/(\.[a-z0-9]+)$/, `-${i}$1`)}`;
    const files = { ...version.files, [rel]: await putBlob(env, bytes) };
    await writeVersion(env, project, files, { source: 'edit', by: email, coalesce: true });
    return json({ ok: true, url: `/${project.slug}/${rel}` });
  }
  if (sub === 'agent-note' && method === 'POST') {
    const b = await body();
    if (!b || typeof b !== 'object') return json({ error: 'expected an object' }, 400);
    if (b.action === 'status') {
      const row = await env.DB.prepare('SELECT * FROM notes WHERE id = ? AND project = ?').bind(String(b.job || ''), project.slug).first();
      if (!row) return json({ error: 'no such note' }, 404);
      return json({ id: row.id, status: row.status === 'no-change' ? 'done' : row.status, detail: row.detail || undefined,
        prUrl: row.result_version ? `${env.PUBLIC_URL || ''}/${project.slug}/v${row.result_version}/` : undefined });
    }
    if (b.action && b.action !== 'note') return json({ error: `${b.action} is not available here` }, 400);
    if (typeof b.note !== 'string' || !b.note.trim()) return json({ error: 'note text required' }, 400);
    if (b.note.length > NOTE_MAX) return json({ error: `notes are limited to ${NOTE_MAX} characters` }, 413);
    const id = hex(crypto.getRandomValues(new Uint8Array(6)));
    const capture = JSON.stringify(b.capture && typeof b.capture === 'object' ? b.capture : {}).slice(0, 20_000);
    await env.DB.prepare('INSERT INTO notes (id, project, version, text, capture, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, project.slug, version.n, b.note, capture, email, 'queued', now()).run();
    return json({ id, status: 'queued' }, 202);
  }
  if (sub === 'live' && method === 'GET') return liveStream(env, ctx);
  return json({ error: 'not found' }, 404);
}

// The editor's live protocol: "content" when the copy changes, "reload" when
// any other file does. A stream ends after LIVE_MS; EventSource reconnects.
function liveStream(env, ctx) {
  if (!ctx.atHead) return json({ error: 'older versions do not change' }, 404);
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(); const enc = new TextEncoder();
  const send = (s) => w.write(enc.encode(s));
  (async () => {
    const start = Date.now();
    let seen = { n: ctx.version.n, files: ctx.version.files, updated: ctx.version.updated_at };
    try {
      await send('retry: 3000\n\n');
      while (Date.now() - start < LIVE_MS) {
        await new Promise((r) => setTimeout(r, 3000));
        const p = await getProject(env, ctx.project.slug);
        const v = p && await getVersion(env, p.slug, p.head);
        if (!v) continue;
        if (v.n !== seen.n || v.updated_at !== seen.updated) {
          const changed = new Set([...Object.keys(v.files), ...Object.keys(seen.files)].filter((k) => v.files[k] !== seen.files[k]));
          const content = p.content_path;
          if ([...changed].some((k) => k !== content)) await send(`event: reload\ndata: ${[...changed][0]}\n\n`);
          else if (changed.has(content)) await send(`event: content\ndata: ${content}\n\n`);
          seen = { n: v.n, files: v.files, updated: v.updated_at };
        } else await send(': keepalive\n\n');
      }
    } catch {} finally { try { await w.close(); } catch {} }
  })();
  return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...NOINDEX } });
}

/* ---------------- machine API: publish + runner ---------------- */

function bearer(req) { return String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim(); }

async function machine(env, req, url) {
  const p = url.pathname.slice('/_hosted'.length);
  const tok = bearer(req);
  const publisher = env.PUBLISH_TOKEN && safeEqual(tok, env.PUBLISH_TOKEN);
  const runner = env.RUNNER_TOKEN && safeEqual(tok, env.RUNNER_TOKEN);
  if (!publisher && !runner) return json({ error: 'unauthorized' }, 401);

  const blob = /^\/blob\/([a-f0-9]{64})$/.exec(p);
  if (blob && req.method === 'PUT') {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_BLOB) return json({ error: 'file too large' }, 413);
    if (await sha256(bytes) !== blob[1]) return json({ error: 'content does not match its hash' }, 400);
    await putBlob(env, bytes);
    return json({ ok: true });
  }
  if (blob && req.method === 'GET') {
    const bytes = await blobBytes(env, blob[1]);
    return bytes ? new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }) : json({ error: 'no such blob' }, 404);
  }
  if (p === '/check' && req.method === 'POST') {
    const b = await req.json().catch(() => null);
    const hashes = Array.isArray(b?.hashes) ? b.hashes.filter((h) => SHA.test(h)).slice(0, MAX_FILES) : [];
    const missing = [];
    for (const h of hashes) if (!(await env.DB.prepare('SELECT sha FROM blobs WHERE sha = ?').bind(h).first())) missing.push(h);
    return json({ missing });
  }

  if (p === '/publish' && req.method === 'POST' && publisher) {
    const b = await req.json().catch(() => null);
    if (!b || !SLUG.test(String(b.project || '')) || RESERVED.has(b.project)) return json({ error: 'project must be a lowercase slug (a-z, 0-9, -)' }, 400);
    const entries = Object.entries(b.files || {});
    if (!entries.length || entries.length > MAX_FILES) return json({ error: `publish between 1 and ${MAX_FILES} files` }, 400);
    const files = {};
    for (const [k, v] of entries) {
      const path = cleanPath(k);
      if (!path || !SHA.test(String(v))) return json({ error: `bad file entry: ${k}` }, 400);
      if (!(await env.DB.prepare('SELECT sha FROM blobs WHERE sha = ?').bind(v).first())) return json({ error: `upload ${path} first` }, 400);
      files[path] = v;
    }
    if (!Object.keys(files).some(isHtml)) return json({ error: 'a project needs at least one .html page' }, 400);
    const contentPath = cleanPath(b.contentPath || 'content/site.json') || 'content/site.json';
    let project = await getProject(env, b.project);
    const stamp = now();
    if (!project) {
      await env.DB.prepare('INSERT INTO projects (slug, title, content_path, head, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .bind(b.project, String(b.title || b.project).slice(0, 200), contentPath, stamp, stamp).run();
      project = await getProject(env, b.project);
    } else if (b.title || b.contentPath) {
      await env.DB.prepare('UPDATE projects SET title = ?, content_path = ? WHERE slug = ?').bind(String(b.title || project.title).slice(0, 200), contentPath, project.slug).run();
      project.content_path = contentPath;
    }
    const n = await writeVersion(env, project, files, { source: 'publish', by: String(b.by || 'agent').slice(0, 120), message: b.message ? String(b.message).slice(0, 500) : null });
    const base = env.PUBLIC_URL || '';
    return json({ ok: true, project: project.slug, version: n, url: `${base}/${project.slug}/`, permalink: `${base}/${project.slug}/v${n}/`, review: `${base}/${project.slug}/review` });
  }

  if (p === '/runner/next' && req.method === 'POST' && runner) {
    const stale = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
    const job = await env.DB.prepare(`UPDATE notes SET status = 'running', claimed_at = ? WHERE id = (
        SELECT id FROM notes WHERE status = 'queued' OR (status = 'running' AND claimed_at < ?) ORDER BY created_at LIMIT 1)
      RETURNING *`).bind(now(), stale).first();
    if (!job) return json({ job: null });
    const project = await getProject(env, job.project);
    const version = await getVersion(env, job.project, job.version);
    return json({ job: { id: job.id, project: job.project, title: project?.title, version: job.version, note: job.text, capture: JSON.parse(job.capture || '{}'),
      email: job.email, contentPath: project?.content_path, files: version?.files || {} } });
  }
  if (p === '/runner/complete' && req.method === 'POST' && runner) {
    const b = await req.json().catch(() => null);
    const job = b && await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(String(b.id || '')).first();
    if (!job || job.status !== 'running') return json({ error: 'no such running note' }, 404);
    const finish = (status, detail, result = null) => env.DB.prepare('UPDATE notes SET status = ?, detail = ?, result_version = ?, finished_at = ? WHERE id = ?')
      .bind(status, detail ? String(detail).slice(0, 1000) : null, result, now(), job.id).run();
    if (!b.ok) { await finish('failed', b.detail || 'the note did not run'); return json({ ok: true }); }
    const changed = Object.entries(b.files || {}); const deleted = Array.isArray(b.deleted) ? b.deleted : [];
    if (!changed.length && !deleted.length) { await finish('no-change', b.detail || 'the agent made no changes'); return json({ ok: true }); }
    const project = await getProject(env, job.project);
    const base = await getVersion(env, job.project, job.version);
    const head = await getVersion(env, job.project, project.head);
    const files = { ...head.files };
    for (const [k, v] of changed) {
      const path = cleanPath(k);
      if (!path || !SHA.test(String(v)) || !(await env.DB.prepare('SELECT sha FROM blobs WHERE sha = ?').bind(v).first())) return json({ error: `bad changed file ${k}` }, 400);
      // Never overwrite something edited on the page while the note ran.
      if ((head.files[path] || null) !== (base.files[path] || null)) { await finish('failed', `${path} was edited while the note ran; nothing was overwritten. Send the note again.`); return json({ ok: true }); }
      files[path] = v;
    }
    for (const k of deleted) {
      const path = cleanPath(k);
      if (path && (head.files[path] || null) !== (base.files[path] || null)) { await finish('failed', `${path} was edited while the note ran; nothing was overwritten. Send the note again.`); return json({ ok: true }); }
      if (path) delete files[path];
    }
    const n = await writeVersion(env, project, files, { source: 'note', by: `ChatGPT plan (${job.email})`, message: job.text.slice(0, 500), noteId: job.id });
    await finish('done', b.detail || null, n);
    return json({ ok: true, version: n });
  }
  return json({ error: 'not found' }, 404);
}

/* ---------------- index + review pages ---------------- */

const sourceLabel = (s) => ({ publish: 'shared by an agent', edit: 'edited on the page', note: '✎ note applied', restore: 'restored' }[s] || s);
const when = (iso) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>
:root{--bg:#0f0e0b;--panel:#161410;--line:#2a261f;--ink:#e8e3d9;--dim:#8a8277;--brass:#c9a96e;--ok:#8fbf7f;--bad:#d98a74}
@media (prefers-color-scheme: light){:root{--bg:#f7f4ee;--panel:#fffdf8;--line:#e4ddcf;--ink:#1d1a15;--dim:#6d665b;--brass:#8a6a2b;--ok:#3d7a2e;--bad:#a5452e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 80px}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 28px}a{color:var(--brass);text-decoration:none}a:hover{text-decoration:underline}
.row{display:flex;gap:14px;align-items:baseline;padding:14px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.n{font:600 13px/1 ui-monospace,Menlo,monospace;color:var(--brass);min-width:38px}.what{flex:1;min-width:220px}
.meta{color:var(--dim);font-size:13px}.tag{font:600 11px/1.6 ui-monospace,Menlo,monospace;padding:1px 7px;border-radius:4px;border:1px solid var(--line);color:var(--dim)}
.tag.ok{color:var(--ok);border-color:currentColor}.tag.bad{color:var(--bad);border-color:currentColor}.tag.head{color:var(--brass);border-color:currentColor}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:36px 0 6px}
button{font:600 12px/1 inherit;padding:6px 10px;border-radius:6px;border:1px solid var(--brass);background:transparent;color:var(--brass);cursor:pointer}
button:disabled{opacity:.5;cursor:default}q{color:var(--ink)}
</style></head><body><main>${body}</main></body></html>`;
}

async function indexPage(env) {
  const rows = (await env.DB.prepare(`SELECT p.*, (SELECT MAX(version) FROM reviews r WHERE r.project = p.slug AND r.reviewed = 1) AS reviewed_v,
      (SELECT COUNT(*) FROM notes n WHERE n.project = p.slug AND n.status IN ('queued','running')) AS open_notes
    FROM projects p WHERE p.head > 0 ORDER BY p.updated_at DESC`).all()).results;
  const list = rows.map((p) => `<div class="row"><span class="n">v${p.head}</span><div class="what"><a href="/${esc(p.slug)}/">${esc(p.title || p.slug)}</a>
    <div class="meta">updated ${esc(when(p.updated_at))} · <a href="/${esc(p.slug)}/review">history</a></div></div>
    ${p.reviewed_v === p.head ? '<span class="tag ok">reviewed</span>' : p.reviewed_v ? `<span class="tag">reviewed v${p.reviewed_v}</span>` : '<span class="tag">not reviewed</span>'}
    ${p.open_notes ? `<span class="tag head">${p.open_notes} note${p.open_notes > 1 ? 's' : ''} running</span>` : ''}</div>`).join('');
  return text(shell('Plater', `<h1>Plater</h1><p class="sub">Everything shared for review. Every version is kept.</p>${list || '<p class="sub">Nothing shared yet.</p>'}`), 200, TYPES.html);
}

async function reviewPage(env, slug, email) {
  const project = await getProject(env, slug);
  if (!project || !project.head) return text('No such project.', 404);
  const versions = (await env.DB.prepare('SELECT n, source, by, message, note_id, created_at, updated_at FROM versions WHERE project = ? ORDER BY n DESC').bind(slug).all()).results;
  const reviews = (await env.DB.prepare('SELECT * FROM reviews WHERE project = ? ORDER BY id').bind(slug).all()).results;
  const notes = (await env.DB.prepare('SELECT * FROM notes WHERE project = ? ORDER BY created_at DESC LIMIT 100').bind(slug).all()).results;
  const marked = new Map(); for (const r of reviews) if (r.path === '*') marked.set(r.version, r.reviewed ? r : null);
  const vrows = versions.map((v) => {
    const m = marked.get(v.n);
    return `<div class="row"><span class="n">v${v.n}</span><div class="what"><a href="/${esc(slug)}/v${v.n}/">${esc(sourceLabel(v.source))}</a>${v.message ? ` — <q>${esc(v.message)}</q>` : ''}
      <div class="meta">${esc(when(v.updated_at))}${v.by ? ` · ${esc(v.by)}` : ''}${m ? ` · reviewed ${esc(when(m.at))} by ${esc(m.email)}` : ''}</div></div>
      ${v.n === project.head ? '<span class="tag head">latest</span>' : ''}
      ${m ? '<span class="tag ok">reviewed</span>' : `<form method="post" action="/${esc(slug)}/review"><input type="hidden" name="version" value="${v.n}"><button>Mark reviewed</button></form>`}</div>`;
  }).join('');
  const nrows = notes.map((n) => `<div class="row"><span class="tag ${n.status === 'done' ? 'ok' : n.status === 'failed' ? 'bad' : ''}">${esc(n.status)}</span>
    <div class="what"><q>${esc(n.text)}</q><div class="meta">on v${n.version} · ${esc(when(n.created_at))}${n.result_version ? ` · became <a href="/${esc(slug)}/v${n.result_version}/">v${n.result_version}</a>` : ''}${n.detail ? ` · ${esc(n.detail)}` : ''}</div></div></div>`).join('');
  return text(shell(`${project.title || slug} · history`, `<p class="meta"><a href="/">Plater</a></p><h1>${esc(project.title || slug)}</h1>
    <p class="sub"><a href="/${esc(slug)}/">Open the latest version</a> · ${versions.length} version${versions.length > 1 ? 's' : ''}, all kept</p>
    <h2>Versions</h2>${vrows}<h2>Notes</h2>${nrows || '<p class="sub">No notes yet. Use ✎ Note on the page.</p>'}`), 200, TYPES.html);
}

/* ---------------- entry ---------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/robots.txt') return text('User-agent: *\nDisallow: /\n');
      if (url.pathname.startsWith('/_hosted/')) return machine(env, req, url);

      const email = await accessUser(req, env);
      if (!email) return text('Sign in through Cloudflare Access to open Plater.', 403);

      if (url.pathname === '/') return indexPage(env);
      if (url.pathname.startsWith('/packages/') || url.pathname.startsWith('/__plater/')) return env.ASSETS.fetch(req);

      const direct = parseProjectPath(url.pathname);
      if (direct && direct.rest === '/review' && direct.n === null) {
        if (req.method === 'POST') {
          const form = await req.formData().catch(() => null);
          const n = Number(form?.get('version'));
          const project = await getProject(env, direct.project);
          if (!project || !Number.isInteger(n) || n < 1 || n > project.head) return text('No such version.', 400);
          await env.DB.prepare('INSERT INTO reviews (project, version, path, hash, reviewed, email, at) VALUES (?, ?, ?, NULL, 1, ?, ?)').bind(project.slug, n, '*', email, now()).run();
          return Response.redirect(`${url.origin}/${project.slug}/review`, 303);
        }
        return reviewPage(env, direct.project, email);
      }
      if (direct && (direct.bare || direct.bareVersion)) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);

      if (url.pathname.startsWith('/api/')) {
        const ref = fromReferer(req);
        const ctx = ref && await loadCtx(env, ref);
        if (!ctx) return json({ error: 'open a Plater project page first' }, 404);
        return api(env, req, ctx, email, url.pathname.slice(5));
      }
      if (direct) {
        const ctx = await loadCtx(env, direct);
        if (!ctx) return text('No such project or version.', 404);
        return serveFile(env, req, ctx, direct.rest);
      }
      // An absolute path from inside a project page: its asset, or (for a
      // navigation) a redirect to the same page inside the project.
      const ref = fromReferer(req);
      const ctx = ref && await loadCtx(env, ref);
      if (!ctx) return text('Not found.', 404);
      if (req.headers.get('sec-fetch-mode') === 'navigate') return Response.redirect(`${url.origin}${ctx.base}${url.pathname.replace(/^\//, '')}${url.search}`, 302);
      return serveFile(env, req, ctx, url.pathname);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
