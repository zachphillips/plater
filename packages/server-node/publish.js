// Static publisher for Plater content trees.
//
// Content lives in content/pages by default. Folders become routes, index files
// own their folder route, and non-index Markdown/HTML files become clean slugs.
// Metadata can override the canonical permalink and declare redirect aliases.
import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_EXT = new Set(['.md', '.markdown', '.html', '.htm']);
const DEFAULT_LAYOUT = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>{{ title }}</title>\n{{ head }}\n</head>\n<body>\n{{ content }}\n</body>\n</html>\n';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const slug = (s) => String(s).toLowerCase()
  .replace(/\.[^.]+$/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((v) => parseScalar(v)) : [];
  }
  return s;
}

export function parseYamlFrontMatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { meta: {}, body: text };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let current = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && current) {
      (meta[current] ??= []).push(parseScalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    current = kv[1];
    meta[current] = kv[2] === '' ? [] : parseScalar(kv[2]);
  }
  return { meta, body: text.slice(m[0].length) };
}

export function parseHtmlMetadata(text) {
  let body = text;
  let meta = {};
  body = body.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs, json) => {
    if (!/\bdata-plater-meta\b/i.test(attrs) || !/\btype=["']application\/json["']/i.test(attrs)) return tag;
    try { meta = { ...meta, ...JSON.parse(json.trim() || '{}') }; } catch {}
    return '';
  });
  for (const m of body.matchAll(/<meta\b([^>]*)>/gi)) {
    const name = attr(m[1], 'name');
    if (!name || !name.toLowerCase().startsWith('plater:')) continue;
    meta[name.slice('plater:'.length)] = attr(m[1], 'content') || '';
  }
  return { meta, body };
}

function attr(attrs, name) {
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, 'i');
  return attrs.match(re)?.[1];
}

export function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  let code = false;
  let codeLines = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMarkdown(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        code = false; codeLines = [];
      } else {
        flushPara(); flushList(); code = true;
      }
      continue;
    }
    if (code) { codeLines.push(line); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const conditional = line.match(/^\[plater-if\s+([a-z-]+)\]\s*$/i);
    if (conditional) { flushPara(); flushList(); out.push(`<section data-plater-if="${escapeHtml(conditional[1])}">`); continue; }
    if (/^\[\/plater-if\]\s*$/i.test(line)) { flushPara(); flushList(); out.push('</section>'); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inlineMarkdown(h[2])}</h${h[1].length}>`); continue; }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!list || list.type !== 'ul') list = { type: 'ul', items: [] };
      list.items.push(li[1]);
      continue;
    }
    para.push(line.trim());
  }
  flushPara(); flushList();
  if (code) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return out.join('\n') + '\n';
}

function safeHref(href) {
  const trimmed = String(href).trim();
  // Browsers strip ASCII control chars/whitespace when parsing URLs, so
  // schemes split by them (e.g. a newline inside "javascript:") still
  // execute. Canonicalize the probe the same way before checking the scheme.
  const probe = trimmed.replace(/[\u0000-\u0020]+/g, '');
  const scheme = probe.match(/^([a-z][a-z0-9+.-]*):/i);
  // Allow relative/fragment links (no scheme) and an allow-list of safe schemes;
  // neutralize everything else (e.g. javascript:, data:, vbscript:).
  if (scheme && !['http', 'https', 'mailto'].includes(scheme[1].toLowerCase())) return '#';
  return trimmed;
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => `<a href="${safeHref(href)}">${label}</a>`);
}

function normalizeRoute(route) {
  let out = String(route || '/').trim().replace(/^\/+/, '');
  out = out.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '/');
  // Drop empty, `.`, and `..` segments so content-controlled permalinks/redirects
  // cannot escape outDir via path traversal.
  const segments = out.split('/').filter((s) => s && s !== '.' && s !== '..');
  out = '/' + segments.join('/');
  if (!out.endsWith('/')) out += '/';
  return out.replace(/\/+/g, '/');
}

function routeFor(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const ext = path.extname(rel);
  const withoutExt = rel.slice(0, -ext.length);
  if (withoutExt === 'index') return '/';
  if (withoutExt.endsWith('/index')) return normalizeRoute(withoutExt.slice(0, -'/index'.length));
  return normalizeRoute(withoutExt.split('/').map(slug).filter(Boolean).join('/'));
}

function outputFile(outDir, route) {
  const normalized = normalizeRoute(route);
  return path.join(outDir, normalized.slice(1), 'index.html');
}

function redirectHtml(to) {
  const url = normalizeRoute(to);
  return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=${escapeHtml(url)}">\n<link rel="canonical" href="${escapeHtml(url)}">\n<script>location.replace(${JSON.stringify(url)})</script>\n`;
}

function platerConditionalRuntime() {
  return `<style>[data-plater-if="logged-in"]{display:none}body.plater-logged-in [data-plater-if="logged-in"]{display:revert}</style>
<script>(function(){try{var ok=false;for(var i=0;i<localStorage.length;i++){if(/\\.editToken$/.test(localStorage.key(i)||'')){ok=true;break}}if(ok)document.body.classList.add('plater-logged-in')}catch(e){}}())</script>`;
}

function applyLayout(page, layout) {
  const title = page.meta.title || page.title || '';
  const head = [
    page.meta.description ? `<meta name="description" content="${escapeHtml(page.meta.description)}">` : '',
    `<link rel="canonical" href="${escapeHtml(page.route)}">`,
    platerConditionalRuntime(),
  ].filter(Boolean).join('\n');
  return layout
    .replaceAll('{{ title }}', escapeHtml(title))
    .replaceAll('{{ head }}', head)
    .replaceAll('{{ content }}', page.content);
}

function titleFromHtml(html) {
  const h = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h) return h[1].replace(/<[^>]+>/g, '').trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? t[1].replace(/<[^>]+>/g, '').trim() : '';
}

function htmlContent(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return (body ? body[1] : html).trim() + '\n';
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (PAGE_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

export async function publishSite(options = {}) {
  const root = path.resolve(options.cwd || process.cwd());
  const contentDir = path.resolve(root, options.contentDir || 'content/pages');
  const outDir = path.resolve(root, options.outDir || 'web');
  const layout = options.layout || DEFAULT_LAYOUT;
  const files = (await walk(contentDir)).sort();
  const pages = [];
  const redirects = [];

  await fs.mkdir(outDir, { recursive: true });

  // Track every output route claimed by a page or redirect so colliding sources
  // (e.g. about.md vs about.html, or a permalink/alias matching another page) are
  // surfaced instead of silently overwriting each other.
  const claimedRoutes = new Map();

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const ext = path.extname(file).toLowerCase();
    const parsed = ext === '.md' || ext === '.markdown'
      ? parseYamlFrontMatter(raw)
      : parseHtmlMetadata(raw);
    const defaultRoute = routeFor(contentDir, file);
    const route = normalizeRoute(parsed.meta.permalink || parsed.meta.url || defaultRoute);
    const content = ext === '.md' || ext === '.markdown' ? markdownToHtml(parsed.body) : htmlContent(parsed.body);
    const page = {
      source: path.relative(root, file).split(path.sep).join('/'),
      defaultRoute,
      route,
      meta: parsed.meta,
      title: parsed.meta.title || titleFromHtml(content),
      content,
    };
    pages.push(page);
    const priorPage = claimedRoutes.get(route);
    if (priorPage) console.warn(`plater: route collision at ${route} — "${page.source}" overwrites "${priorPage}"`);
    claimedRoutes.set(route, page.source);
    await fs.mkdir(path.dirname(outputFile(outDir, route)), { recursive: true });
    await fs.writeFile(outputFile(outDir, route), applyLayout(page, layout));

    const aliases = new Set([defaultRoute, ...asArray(parsed.meta.redirects), ...asArray(parsed.meta.redirect_from)]);
    aliases.delete(route);
    for (const alias of aliases) {
      const from = normalizeRoute(alias);
      const priorClaim = claimedRoutes.get(from);
      if (priorClaim) {
        console.warn(`plater: redirect ${from} from "${page.source}" skipped — route already claimed by "${priorClaim}"`);
        continue;
      }
      claimedRoutes.set(from, `${page.source} (redirect)`);
      redirects.push({ from, to: route });
      await fs.mkdir(path.dirname(outputFile(outDir, from)), { recursive: true });
      await fs.writeFile(outputFile(outDir, from), redirectHtml(route));
    }
  }

  const manifest = { generated_at: new Date().toISOString(), content_dir: path.relative(root, contentDir), out_dir: path.relative(root, outDir), pages, redirects };
  await fs.writeFile(path.join(outDir, 'plater-publish.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export default publishSite;

function asArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}
