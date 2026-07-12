// GET /api/manifest (also /.well-known/plater.json via rewrite) — the site,
// machine-readable. THE agent-first endpoint: one GET tells any agent what
// pages exist, what content keys each binds, what's reviewed/stale, where the
// feed and redirects live, and HOW TO EDIT — the write path is documented in
// the response itself, so an agent that discovers a Plater site can edit it
// without ever reading Plater's source.
//
// Read-only, no auth (it reveals structure, never secrets or tokens).
//
// Also serves /llms.txt when hit with ?format=llms — the emerging convention
// for handing a site to an LLM: H1 + summary + curated links, generated from
// the same manifest + curated feed (nothing to maintain by hand).
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const SITE_URL = (process.env.CMS_SITE_URL || '').trim().replace(/\/+$/, '');
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';
const WEB_ROOT = process.env.PLATER_WEB_ROOT || process.env.ZMS_WEB_ROOT || '';
const REVIEW_PATH = process.env.PLATER_REVIEW_PATH || '.plater-review.json';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';

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

function descriptionOf(html) {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  return m ? m[1].trim() : '';
}

function boundKeys(html) {
  const keys = new Set();
  for (const re of [
    /data-(?:bind|list|cards|links|bind-attr)\s*=\s*"([^"]+)"/g,
    /data-(?:bind|list|cards|links|bind-attr)\s*=\s*'([^']+)'/g,
  ]) {
    let m;
    while ((m = re.exec(html))) keys.add(m[1].split(':')[0]);
  }
  return [...keys].sort();
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(path.resolve(process.cwd(), p), 'utf8')); }
  catch { return fallback; }
}

export async function buildManifest() {
  const content = await readJson(CONTENT_PATH, {});
  const review = await readJson(REVIEW_PATH, {});
  const base = String(SITE_URL || content?.meta?.url || '').trim().replace(/\/+$/, '');
  const root = await resolveWebRoot();
  const files = (await walkHtml(root)).sort();
  const pages = [];
  for (const f of files) {
    const html = await fs.readFile(f, 'utf8').catch(() => '');
    const p = pageUrl(root, f);
    const rec = review[p];
    pages.push({
      path: p,
      url: base ? base + p : p,
      title: titleOf(html),
      description: descriptionOf(html),
      binds: boundKeys(html),
      reviewed_at: rec?.reviewed_at || null,
    });
  }
  return {
    plater: true,
    site: SITE_NAME,
    url: base || null,
    repo: GITHUB_REPOSITORY || null,
    generated_at: new Date().toISOString(),
    pages,
    feed: Array.isArray(content?.feed?.items)
      ? { url: base + '/feed.xml', json_url: base + '/feed.json', items: content.feed.items.length }
      : null,
    redirects: Array.isArray(content?.redirects) ? content.redirects.length : 0,
    // The write path, self-described. An agent reads this and knows how to edit.
    edit: {
      content_endpoint: '/api/content',
      content_path: CONTENT_PATH,
      save_endpoint: '/api/save',
      save_method: 'POST',
      save_auth: 'Authorization: Bearer <google id token | site edit token>',
      save_body: '{ "content": { "<topLevelKey>": <full new value> } } — each posted top-level key REPLACES that key (shallow merge), then the whole file commits to git. To edit feed/redirects, post the complete updated array under its key.',
      note_endpoint: '/api/agent-note',
      note_body: '{ "note": "<instruction>", "capture": {…}, "route": { "engine": "claude|codex", "output": "pr|push" } } — runs a coding agent against this site\'s repo',
      review_endpoint: '/api/review',
      laws: [
        'every save is a git commit — nothing is ever lost',
        'renaming a URL requires adding a redirect to site.json `redirects` in the same change',
        'the feed (site.json `feed.items`) is hand-curated content: never auto-append, never reorder without being asked, never change an item id',
        'no tags, no categories, no taxonomies — do not invent them',
      ],
    },
  };
}

export function llmsTxt(manifest, content) {
  const lines = [];
  lines.push(`# ${content?.meta?.title || manifest.site}`);
  lines.push('');
  if (content?.meta?.description) lines.push(`> ${content.meta.description}`);
  lines.push('');
  lines.push('## Pages');
  lines.push('');
  for (const p of manifest.pages) {
    lines.push(`- [${p.title || p.path}](${p.url})${p.description ? `: ${p.description}` : ''}`);
  }
  const items = Array.isArray(content?.feed?.items) ? content.feed.items : [];
  if (items.length) {
    lines.push('');
    lines.push('## Curated feed');
    lines.push('');
    for (const it of items) {
      lines.push(`- [${it.title || it.url || it.id}](${it.url || it.id})${it.description ? `: ${it.description}` : ''}`);
    }
  }
  lines.push('');
  lines.push('## For agents');
  lines.push('');
  lines.push(`- [Machine-readable site manifest (pages, content bindings, edit API)](${manifest.url || ''}/api/manifest)`);
  return lines.join('\n') + '\n';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  try {
    const manifest = await buildManifest();
    res.setHeader('cache-control', 'public, max-age=300');
    if (/llms/i.test(String(req.query?.format || req.url || ''))) {
      const content = await readJson(CONTENT_PATH, {});
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.status(200).send(llmsTxt(manifest, content));
    }
    return res.status(200).json(manifest);
  } catch (e) {
    return res.status(500).json({ error: 'manifest failed: ' + e.message });
  }
}
