// plater share <dir> [--project <slug>] [--title <title>] [--message <text>]
//
// Shares a draft (a site, a deck, a proposal) to hosted Plater as a new version
// of a project and prints its permanent links:
//   https://plater.thekitchen.co/<project>/          latest, editable in place
//   https://plater.thekitchen.co/<project>/v<n>/     this exact version, forever
//   https://plater.thekitchen.co/<project>/review    every version and review
//
// Only files that are not already stored are uploaded (content-addressed). The
// web root is found the same way `plater dev` finds it; dotfiles, node_modules
// and files over 25 MB are left out. Needs PLATER_PUBLISH_TOKEN; the host
// defaults to https://plater.thekitchen.co (PLATER_HOSTED_URL overrides).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSite } from './dev.mjs';

const MAX = 25 * 1024 * 1024;
const SKIP_DIR = new Set(['node_modules', '.git']);

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'draft';
}

export function collect(webRoot) {
  const files = {}; const skipped = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const abs = path.join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        const size = fs.statSync(abs).size;
        if (size > MAX) { skipped.push(r); continue; }
        files[r] = abs;
      }
    }
  };
  walk(webRoot, '');
  return { files, skipped };
}

export async function share(dir, { project, title, message, by, url = process.env.PLATER_HOSTED_URL || 'https://plater.thekitchen.co',
  token = process.env.PLATER_PUBLISH_TOKEN, fetch: fetchImpl = fetch, log = () => {} } = {}) {
  if (!token) throw new Error('PLATER_PUBLISH_TOKEN is not set (source ~/.agents/secrets/plater.env)');
  const site = resolveSite(dir);
  if (site.entry) throw new Error('share a folder, not a single file (put the page in its own folder)');
  const { files, skipped } = collect(site.webRoot);
  if (!Object.keys(files).some((f) => /\.html?$/i.test(f))) throw new Error(`no .html pages under ${site.webRoot}`);
  const base = url.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${token}` };
  const manifest = {}; const bytesBySha = new Map();
  for (const [rel, abs] of Object.entries(files)) {
    const bytes = fs.readFileSync(abs);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    manifest[rel] = sha; bytesBySha.set(sha, abs);
  }
  const call = async (p, init) => {
    const r = await fetchImpl(base + p, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${out.error || r.status}`);
    return out;
  };
  const { missing } = await call('/_hosted/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: [...bytesBySha.keys()] }) });
  for (const sha of missing) await call(`/_hosted/blob/${sha}`, { method: 'PUT', body: fs.readFileSync(bytesBySha.get(sha)) });
  log(`uploaded ${missing.length} new file(s), ${bytesBySha.size - missing.length} already stored`);
  const indexHtml = files['index.html'] ? fs.readFileSync(files['index.html'], 'utf8') : '';
  const contentPath = path.relative(site.webRoot, site.contentPath).split(path.sep).join('/');
  return {
    ...(await call('/_hosted/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      project: project || slugify(path.basename(site.siteDir)),
      title: title || (/<title[^>]*>([^<]*)<\/title>/i.exec(indexHtml) || [])[1]?.trim() || undefined,
      files: manifest, contentPath: contentPath.startsWith('..') ? undefined : contentPath, by, message }) })),
    skipped,
  };
}

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const dir = process.argv[2] === 'share' ? process.argv[3] : process.argv[2];
  if (!dir || dir.startsWith('--')) { console.log('usage: platercms share <dir> [--project <slug>] [--title <t>] [--message <m>]'); process.exit(1); }
  const out = await share(dir, { project: arg('project') && slugify(arg('project')), title: arg('title'), message: arg('message'),
    by: arg('by') || process.env.PLATER_SHARED_BY || (await import('node:os')).hostname(), log: (m) => console.log(m) });
  console.log(`shared ${out.project} v${out.version}`);
  console.log(`  latest   ${out.url}`);
  console.log(`  this one ${out.permalink}`);
  console.log(`  history  ${out.review}`);
  if (out.skipped.length) console.log(`  left out (over 25 MB): ${out.skipped.join(', ')}`);
}

const self = process.argv[1] && fs.realpathSync(process.argv[1]);
const here = fs.realpathSync(new URL(import.meta.url).pathname);
if (self === here || (process.argv[2] === 'share' && /plater\.js$/.test(self || ''))) main().catch((e) => { console.error(e.message); process.exit(1); });
