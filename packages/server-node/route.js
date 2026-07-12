// The fallback route: REDIRECTS-AS-CONTENT + the editable 404.
//
// Wired as the LAST vercel.json rewrite — Vercel serves real files first, so
// this only runs for paths that don't exist:
//   { "source": "/(.*)", "destination": "/api/route" }
//
// Redirects live in site.json (edited via /api/save exactly like page copy —
// by hand or by an agent — and live the moment the commit deploys):
//   "redirects": [
//     { "from": "/old-thing/", "to": "/new-thing/", "permanent": true }
//   ]
// permanent:true → 308 (method-preserving permanent), else 302. `to` may be
// absolute (cross-site forwarding is a feature, not an error).
//
// The permalink law, made mechanical: when an agent renames a URL it MUST add
// a redirect here in the same commit. `plater doctor` checks the manifest for
// routes that vanished without one.
//
// Everything else gets the 404 page — with copy from site.json:
//   "notFound": { "title": "…", "body": "…", "homeLabel": "…" }
// served with a REAL 404 status (never a soft 200).
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function readContent() {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), CONTENT_PATH), 'utf8'));
  } catch {
    return {};
  }
}

function normalize(p) {
  let out = '/' + String(p || '/').replace(/^\/+/, '');
  try { out = decodeURIComponent(out); } catch {}
  if (!out.endsWith('/')) out += '/';
  return out.toLowerCase();
}

// Only http(s) or same-site relative targets; anything else is ignored so a
// bad edit can't turn the site into an open redirect for javascript:/data:.
function safeTarget(to) {
  const t = String(to || '').trim();
  if (t.startsWith('/')) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

export function matchRedirect(content, rawPath) {
  const rules = Array.isArray(content?.redirects) ? content.redirects : [];
  const p = normalize(rawPath);
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    if (normalize(r.from) !== p) continue;
    const to = safeTarget(r.to);
    if (!to) continue;
    return { to, status: r.permanent ? 308 : 302 };
  }
  return null;
}

export function notFoundHtml(content) {
  const nf = content?.notFound || {};
  const title = nf.title || 'Page not found';
  const body = nf.body || 'This page does not exist — it may have moved without leaving a forwarding address.';
  const homeLabel = nf.homeLabel || 'Back to the front page';
  const site = content?.meta?.title || SITE_NAME;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — ${esc(site)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:38rem;margin:18vh auto 0;padding:0 1.5rem;line-height:1.55;color:#1a1a1a;background:#faf9f6}
h1{font-size:1.6rem;margin:0 0 .6rem}
p{color:#4a4a4a;margin:0 0 1.4rem}
a{color:inherit;font-weight:600}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p>${esc(body)}</p>
<p><a href="/">${esc(homeLabel)}</a></p>
</body>
</html>
`;
}

export default async function handler(req, res) {
  const content = await readContent();
  const rawPath = (() => {
    // Vercel rewrites keep the ORIGINAL path in the request URL.
    try { return new URL(req.url, 'http://x').pathname; } catch { return req.url || '/'; }
  })();
  const hit = matchRedirect(content, rawPath);
  if (hit) {
    res.setHeader('cache-control', hit.status === 308 ? 'public, max-age=3600' : 'no-cache');
    res.setHeader('location', hit.to);
    return res.status(hit.status).end();
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  return res.status(404).send(notFoundHtml(content));
}
