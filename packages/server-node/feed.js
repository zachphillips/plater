// GET /feed.xml + /feed.json — the site's HAND-CURATED feed.
//
// Philosophy: the feed is CONTENT, not a query. It serializes the `feed`
// object in site.json — a list a human or agent curates exactly the way they
// edit a page (same /api/save path, same git commit). Reorder by reordering
// the array. Write the descriptions by hand. Point items at ANY url — a
// one-off side-project page, another fleet site, an external link. No posts
// table, no categories, no tags, ever.
//
// site.json shape:
//   "feed": {
//     "title": "…",            (defaults to meta.title)
//     "description": "…",      (defaults to meta.description)
//     "items": [
//       { "id":  "https://site/thing/",   ← REQUIRED, stable forever (readers
//                                            dedupe on it; changing it re-delivers)
//         "url": "https://site/thing/",
//         "title": "…",
//         "description": "hand-written blurb",
//         "date": "2026-07-12T10:00:00-04:00" }  ← RFC 3339; the ONE stored format
//     ]
//   }
//
// Dates are stored ONCE as RFC 3339 and converted here: RSS pubDate needs
// RFC 822 (four-digit year, GMT) — the single most hand-mangled format in feed
// validation, so humans and agents never write it directly.
//
// Wire in vercel.json:
//   { "source": "/feed.xml",  "destination": "/api/feed?format=rss" },
//   { "source": "/feed.json", "destination": "/api/feed?format=json" }
// and add includeFiles web/content/** to api/feed.js (like content.js).
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_URL = (process.env.CMS_SITE_URL || '').trim().replace(/\/+$/, '');

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

// RFC 3339 (stored) → RFC 822 with GMT zone (what every RSS validator accepts).
// Invalid/missing dates return null and the element is omitted — both specs
// allow dateless items; an invalid pubDate fails validation.
function rfc822(rfc3339) {
  if (!rfc3339) return null;
  const d = new Date(rfc3339);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

function siteBase(content) {
  return String(SITE_URL || content?.meta?.url || '').trim().replace(/\/+$/, '');
}

// Normalize + validate curated items so hand edits can't break readers.
// Returns { items, problems } — problems surface in an X-Plater-Feed-Warnings
// header (agent-visible) instead of breaking the feed.
function curatedItems(content) {
  const raw = Array.isArray(content?.feed?.items) ? content.feed.items : [];
  const base = siteBase(content);
  const items = [];
  const problems = [];
  for (const [i, it] of raw.entries()) {
    if (!it || typeof it !== 'object') { problems.push(`item ${i}: not an object`); continue; }
    const abs = (u) => (u && !/^https?:\/\//i.test(u) && base ? base + (u.startsWith('/') ? u : '/' + u) : u);
    const url = abs(it.url || it.id);
    const id = abs(it.id || it.url);
    if (!id) { problems.push(`item ${i}: missing id/url — skipped`); continue; }
    if (!it.title && !it.description) problems.push(`item ${i} (${id}): needs a title or a description`);
    if (it.date && !rfc822(it.date)) problems.push(`item ${i} (${id}): date "${it.date}" is not RFC 3339 — omitted`);
    items.push({ id, url, title: it.title || '', description: it.description || '', date: it.date || null });
  }
  return { items, problems };
}

export function rssXml(content, feedUrl) {
  const base = siteBase(content);
  const { items, problems } = curatedItems(content);
  const title = content?.feed?.title || content?.meta?.title || 'Feed';
  const description = content?.feed?.description || content?.meta?.description || '';
  const newest = items.map((i) => i.date).filter(Boolean).sort().pop();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${esc(title)}</title>
<link>${esc(base || feedUrl)}</link>
<description>${esc(description)}</description>
${feedUrl ? `<atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>` : ''}
${rfc822(newest) ? `<lastBuildDate>${rfc822(newest)}</lastBuildDate>` : ''}
${items.map((it) => `<item>
${it.title ? `<title>${esc(it.title)}</title>` : ''}
${it.url ? `<link>${esc(it.url)}</link>` : ''}
${it.description ? `<description>${esc(it.description)}</description>` : ''}
<guid isPermaLink="true">${esc(it.id)}</guid>
${rfc822(it.date) ? `<pubDate>${rfc822(it.date)}</pubDate>` : ''}
</item>`).join('\n')}
</channel>
</rss>
`.replace(/\n{2,}/g, '\n');
  return { body: xml, problems };
}

export function jsonFeed(content, feedUrl) {
  const base = siteBase(content);
  const { items, problems } = curatedItems(content);
  const body = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: content?.feed?.title || content?.meta?.title || 'Feed',
    ...(base ? { home_page_url: base } : {}),
    ...(feedUrl ? { feed_url: feedUrl } : {}),
    ...(content?.feed?.description || content?.meta?.description
      ? { description: content?.feed?.description || content?.meta?.description } : {}),
    items: items.map((it) => ({
      id: it.id,
      ...(it.url ? { url: it.url } : {}),
      ...(it.title ? { title: it.title } : {}),
      // curated blurbs are plain text; content_text is the honest field
      content_text: it.description || it.title || '',
      ...(it.date && rfc822(it.date) ? { date_published: it.date } : {}),
    })),
  }, null, 2) + '\n';
  return { body, problems };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const content = await readContent();
  const base = siteBase(content);
  const wantJson = /json/i.test(String(req.query?.format || req.url || ''));
  const feedUrl = base ? base + (wantJson ? '/feed.json' : '/feed.xml') : '';
  const out = wantJson ? jsonFeed(content, feedUrl) : rssXml(content, feedUrl);
  res.setHeader('cache-control', 'public, max-age=300');
  if (out.problems.length) res.setHeader('x-plater-feed-warnings', out.problems.join(' | ').slice(0, 900));
  res.setHeader('content-type', wantJson ? 'application/feed+json; charset=utf-8' : 'application/rss+xml; charset=utf-8');
  return res.status(200).send(out.body);
}
