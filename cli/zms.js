#!/usr/bin/env node
// zms — wire and verify ZMS (Heard CMS) on a site.
//   zms doctor [dir]   inspect a site's ZMS wiring + print an env checklist
//   zms init   [dir]   vendor the client modules + scaffold the api handlers
//   zms sync   [dir]   re-sync vendored files from this repo (overwrites, adds
//                      provenance banners, writes .zms-sync.json manifest).
//                      Sites NEVER hand-edit synced files — edit here, re-sync.
//                      The ibsky Gardener compares manifest SHAs to detect drift.
//
// Dependency-free. Assumes a static/Node site laid out like the Sherwood
// reference: a web root (default web/) served statically + serverless api/.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'packages');
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (s) => `${C.g}✓${C.x} ${s}`;
const no = (s) => `${C.r}✗${C.x} ${s}`;
const warn = (s) => `${C.y}!${C.x} ${s}`;

const ENV = [
  ['CMS_ADMIN_EMAIL', 'admin allowlist (e.g. zach@thekitchen.co)'],
  ['CMS_EDIT_TOKEN', 'shared edit token (iPad-first fallback; never exposed)'],
  ['GOOGLE_CLIENT_ID', 'Google SSO (optional; gates editability if set)'],
  ['GITHUB_TOKEN', 'fine-grained PAT, contents:write'],
  ['GITHUB_REPOSITORY', 'org/repo the CMS commits to'],
  ['GITHUB_BRANCH', 'commit branch (default main)'],
  ['GITHUB_EDIT_PATH', 'content path (default web/content/site.json)'],
  ['CMS_SITE_NAME', 'short name used in commit messages'],
  ['ZMS_AGENT_ENDPOINT', 'agent host URL (enables note→agent routing)'],
  ['ZMS_AGENT_TOKEN', 'bearer secret shared with the agent host'],
  ['ZMS_WEB_ROOT', 'static web root for sitemap page enumeration (optional)'],
  ['PLATER_REVIEW_PATH', 'review-state file (default .plater-review.json)'],
  ['PLATER_REVIEW_WEBHOOK', 'reviewWebhook — POSTed when the site becomes fully reviewed'],
];

function findWebRoot(dir) {
  for (const w of ['web', 'public', '.']) {
    if (fs.existsSync(path.join(dir, w, 'index.html'))) return w;
  }
  return 'web';
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p) => fs.existsSync(p);

function doctor(dir) {
  const web = findWebRoot(dir);
  const webAbs = path.join(dir, web);
  const apiAbs = path.join(dir, 'api');
  console.log(`${C.b}ZMS doctor${C.x} ${C.d}${path.resolve(dir)} (web=${web}/)${C.x}\n`);

  const html = fs.existsSync(webAbs) ? fs.readdirSync(webAbs).filter((f) => f.endsWith('.html')).map((f) => read(path.join(webAbs, f))).join('\n') : '';
  const appjs = read(path.join(webAbs, 'app.js'));

  const checks = [
    ['client: zms-core.js vendored', exists(path.join(webAbs, 'zms-core.js'))],
    ['client: initZMS() called', /initZMS\s*\(/.test(appjs)],
    ['client: zms-capture.js vendored', exists(path.join(webAbs, 'zms-capture.js')), 'note→agent optional'],
    ['client: initCapture() called', /initCapture\s*\(/.test(appjs), 'note→agent optional'],
    ['markup: #cms-bar present', /id=["\']cms-bar["\']/.test(html)],
    ['markup: data-bind bindings present', /data-bind=/.test(html)],
    ['api/config.js', exists(path.join(apiAbs, 'config.js'))],
    ['api/content.js', exists(path.join(apiAbs, 'content.js'))],
    ['api/save.js', exists(path.join(apiAbs, 'save.js'))],
    ['api/agent-note.js', exists(path.join(apiAbs, 'agent-note.js')), 'note→agent optional'],
    ['api/review.js', exists(path.join(apiAbs, 'review.js')), 'sitemap review optional'],
  ];
  let hard = 0;
  for (const [label, pass, opt] of checks) {
    console.log(pass ? ok(label) : (opt ? warn(`${label} ${C.d}(${opt})${C.x}`) : no(label)));
    if (!pass && !opt) hard++;
  }
  console.log(`\n${C.b}Env checklist${C.x} ${C.d}(set in Vercel; leave editing off by omitting auth)${C.x}`);
  for (const [k, desc] of ENV) console.log(`  ${C.d}${k.padEnd(20)}${C.x} ${desc}`);
  console.log(`\n${hard === 0 ? ok('wiring looks complete') : no(`${hard} required piece(s) missing`)} — editing still gated on env (token or Google).`);
  process.exit(hard === 0 ? 0 : 1);
}

function init(dir) {
  const web = findWebRoot(dir);
  const webAbs = path.join(dir, web);
  const apiAbs = path.join(dir, 'api');
  fs.mkdirSync(webAbs, { recursive: true });
  fs.mkdirSync(apiAbs, { recursive: true });
  // vendor client modules
  fs.copyFileSync(path.join(PKG, 'core/src/editor.js'), path.join(webAbs, 'zms-core.js'));
  fs.copyFileSync(path.join(PKG, 'capture/src/capture.js'), path.join(webAbs, 'zms-capture.js'));
  // scaffold api handlers as re-exports of the vendored server package
  for (const name of HANDLERS) {
    const dst = path.join(apiAbs, `${name}.js`);
    if (!exists(dst)) fs.copyFileSync(path.join(PKG, 'server-node', `${name}.js`), dst);
  }
  console.log(ok(`vendored zms-core.js + zms-capture.js into ${web}/`));
  console.log(ok(`scaffolded ${HANDLERS.map((h) => `api/${h}.js`).join(', ')}`));
  console.log(`\n${C.b}Next:${C.x}`);
  console.log(`  1. Add the CMS bar markup + data-bind attributes (see examples/static-site/index.html)`);
  console.log(`  2. In your page: import { initZMS } from './${web === '.' ? '' : ''}zms-core.js'; initZMS({ brand: '…' })`);
  console.log(`  3. Set env in Vercel, then run: zms doctor ${dir}`);
}

// Server handlers scaffolded by `init` and kept in lockstep by `sync`.
// Single source of truth — add new handlers here only.
const HANDLERS = ['config', 'content', 'save', 'agent-note', 'review'];

// Files kept in lockstep between this repo and consuming sites.
const SYNC_MAP = [
  ['core/src/editor.js', (web) => path.join(web, 'zms-core.js')],
  ['capture/src/capture.js', (web) => path.join(web, 'zms-capture.js')],
  ...HANDLERS.map((h) => [`server-node/${h}.js`, () => path.join('api', `${h}.js`)]),
];

function sync(dir) {
  const web = findWebRoot(dir);
  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: path.resolve(HERE, '..') }).toString().trim();
  } catch {}
  const synced = [];
  for (const [src, dstFn] of SYNC_MAP) {
    const dstRel = dstFn(web);
    const dstAbs = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    const body = read(path.join(PKG, src));
    if (!body) { console.log(no(`missing source ${src}`)); process.exit(1); }
    const banner = `// GENERATED by \`zms sync\` from zachphillips/ZMS@${sha} (packages/${src})\n// DO NOT EDIT HERE — edit in ~/Dev/ZMS and re-run: node ~/Dev/ZMS/cli/zms.js sync .\n`;
    fs.writeFileSync(dstAbs, banner + body);
    synced.push(dstRel);
    console.log(ok(`synced ${dstRel}`));
  }
  const manifest = { source: 'zachphillips/ZMS', commit: sha, synced: new Date().toISOString(), files: synced };
  fs.writeFileSync(path.join(dir, '.zms-sync.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(ok(`.zms-sync.json manifest written (source @${sha})`));
  console.log(`${C.d}Run zms doctor to verify wiring; commit the synced files with the site.${C.x}`);
}

const [, , cmd, dir = '.'] = process.argv;
if (cmd === 'doctor') doctor(dir);
else if (cmd === 'init') init(dir);
else if (cmd === 'sync') sync(dir);
else { console.log('usage: zms <doctor|init|sync> [dir]'); process.exit(1); }
