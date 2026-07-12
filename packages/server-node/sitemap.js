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
const SITE_URL = (process.env.CMS_SITE_URL || '').replace(/\/$/, '');
const WEB_ROOT = process.env.PLATER_WEB_ROOT || process.env.ZMS_WEB_ROOT || '';
const REVIEW_PATH = process.env.PLATER_REVIEW_PATH || '.plater-review.json';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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

export async function sitemapXml() {
  const content = await readJson(CONTENT_PATH, {});
  const review = await readJson(REVIEW_PATH, {});
  const base = (SITE_URL || content?.meta?.url || '').replace(/\/$/, '');
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
    const { xml, base } = await sitemapXml();
    if (!base) return res.status(500).send('sitemap needs CMS_SITE_URL or meta.url in site.json (absolute URLs are required)');
    res.setHeader('cache-control', 'public, max-age=300');
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (e) {
    return res.status(500).send('sitemap failed: ' + e.message);
  }
}
