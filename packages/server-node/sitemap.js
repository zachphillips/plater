// GET /sitemap.xml — serialized from the SAME page enumeration the review
// checklist uses (review.js walks the web root), so the sitemap can never
// disagree with the site. Curation, not crawling: a page can opt out with
// <meta name="plater:sitemap" content="false">, and site.json `sitemap.exclude`
// (array of paths) is the content-editable override — edited via /api/save
// like any other copy.
//
// lastmod is the review-state content hash's reviewed_at when fresh, else
// omitted — Google only trusts lastmod that is "consistently and verifiably
// accurate", and a fabricated now() is worse than nothing. No changefreq, no
// priority: Google ignores both.
//
// Wire in vercel.json:
//   { "source": "/sitemap.xml", "destination": "/api/sitemap" }
// and give api/sitemap.js includeFiles web/** (it reads the page files).
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_URL = (process.env.CMS_SITE_URL || '').trim().replace(/\/+$/, '');
const WEB_ROOT = process.env.PLATER_WEB_ROOT || process.env.ZMS_WEB_ROOT || '';
const REVIEW_PATH = process.env.PLATER_REVIEW_PATH || '.plater-review.json';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Last-resort origin: the request that asked. A site reachable at a host IS
// published at that host, so answering with the crawler's own origin beats a
// 500 on an unconfigured deploy — but only as a fallback, since the Host header
// is attacker-controlled and CMS_SITE_URL / meta.url are not. Proxies speak
// x-forwarded-*; without them a host carrying a port (or a raw IPv6 literal) is
// a dev/LAN box on http and a bare hostname is a public site on https.
// Anything that is not a plain host[:port] is refused rather than trusted.
function requestOrigin(req) {
  const raw = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(raw)) return '';
  const fwd = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = fwd === 'https' || fwd === 'http' ? fwd : (/:\d{1,5}$/.test(raw) || raw.startsWith('[') ? 'http' : 'https');
  return `${proto}://${raw}`;
}

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

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(path.resolve(process.cwd(), p), 'utf8')); }
  catch { return fallback; }
}

// `fallbackBase` is used only when neither CMS_SITE_URL nor meta.url is set —
// configuration always wins over anything derived from the request.
export async function sitemapXml(fallbackBase = '') {
  const content = await readJson(CONTENT_PATH, {});
  const review = await readJson(REVIEW_PATH, {});
  const base = String(SITE_URL || content?.meta?.url || fallbackBase || '').trim().replace(/\/+$/, '');
  const exclude = new Set(
    (Array.isArray(content?.sitemap?.exclude) ? content.sitemap.exclude : []).map(String),
  );
  const root = await resolveWebRoot();
  const files = (await walkHtml(root)).sort();
  const urls = [];
  for (const f of files) {
    const p = pageUrl(root, f);
    if (exclude.has(p)) continue;
    const html = await fs.readFile(f, 'utf8').catch(() => '');
    if (/<meta\s+name=["']plater:sitemap["']\s+content=["']false["']/i.test(html)) continue;
    if (/<meta\s+name=["']robots["'][^>]*noindex/i.test(html)) continue;
    // lastmod only when we can back it: the page was reviewed and hasn't
    // changed since (review record still valid ⇒ reviewed_at is a true
    // "content verified as of" timestamp).
    const rec = review[p];
    const lastmod = rec?.reviewed_at || null;
    urls.push({ loc: base + p, lastmod });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
  return { xml, count: urls.length, base };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  try {
    const { xml, base } = await sitemapXml(requestOrigin(req));
    // Only reachable when the request carried no usable Host either (a raw
    // HTTP/1.0 hit): still absolute-URLs-or-nothing, never a relative sitemap.
    if (!base) return res.status(500).send('sitemap needs CMS_SITE_URL or meta.url in site.json (absolute URLs are required)');
    res.setHeader('cache-control', 'public, max-age=300');
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (e) {
    return res.status(500).send('sitemap failed: ' + e.message);
  }
}
