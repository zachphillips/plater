#!/usr/bin/env node
// plater — wire and verify Plater on a site.
//   plater init    [dir]  a RUNNING site: the starter (index.html, content,
//                         styles, vercel.json, .env.example, README) + the
//                         vendored client modules + the api/ handlers. Never
//                         overwrites a file that is already there.
//   plater dev     [dir]  serve it locally, no auth, saves straight to disk
//   plater serve   [dir]  serve it for real: auth on, env from the host + .env
//   plater doctor  [dir]  inspect a site's Plater wiring + print an env checklist
//   plater sync    [dir]  re-sync vendored files from this repo (overwrites, adds
//                         provenance banners, writes .plater-sync.json manifest).
//                      Sites NEVER hand-edit synced files — edit here, re-sync.
//                      The manifest SHAs let a fleet tool detect drift.
//   plater publish [dir]  build content/pages Markdown/HTML into clean static routes.
//
// Dependency-free. Assumes a static/Node site laid out the usual way: a web
// root (default web/) served statically + serverless api/ handlers.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolved against THIS file, never cwd: `platercms init` runs from the site
// dir (or from an npx cache), so a relative template path would miss.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', 'packages');
const STARTER = path.resolve(HERE, '..', 'templates', 'starter');
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (s) => `${C.g}✓${C.x} ${s}`;
const no = (s) => `${C.r}✗${C.x} ${s}`;
const warn = (s) => `${C.y}!${C.x} ${s}`;

const ENV = [
  ['CMS_ADMIN_EMAIL', 'admin allowlist (e.g. you@example.com)'],
  ['CMS_EDIT_TOKEN', 'shared edit token (iPad-first fallback; never exposed)'],
  ['GOOGLE_CLIENT_ID', 'Google SSO (optional; gates editability if set)'],
  ['GITHUB_TOKEN', 'fine-grained PAT, contents:write'],
  ['GITHUB_REPOSITORY', 'org/repo the CMS commits to'],
  ['GITHUB_BRANCH', 'commit branch (default main)'],
  ['GITHUB_EDIT_PATH', 'content path (default web/content/site.json)'],
  ['CMS_SITE_NAME', 'short name used in commit messages'],
  ['CMS_SITE_URL', 'absolute site origin (feeds + sitemap need it; falls back to site.json meta.url)'],
  ['PLATER_AGENT_ENDPOINT', 'agent host URL (enables note→agent routing; ZMS_AGENT_ENDPOINT still accepted)'],
  ['PLATER_AGENT_TOKEN', 'bearer secret shared with the agent host (ZMS_AGENT_TOKEN still accepted)'],
  ['PLATER_WEB_ROOT', 'static web root for sitemap page enumeration (optional; ZMS_WEB_ROOT still accepted)'],
  ['PLATER_REVIEW_PATH', 'review-state file (default .plater-review.json)'],
  ['PLATER_REVIEW_WEBHOOK', 'reviewWebhook — POSTed when the site becomes fully reviewed'],
];

async function publish(dir) {
  const { publishSite } = await import('../packages/server-node/publish.js');
  const manifest = await publishSite({ cwd: dir });
  console.log(ok(`published ${manifest.pages.length} page(s) to ${manifest.out_dir}/`));
  if (manifest.redirects.length) console.log(ok(`wrote ${manifest.redirects.length} redirect(s)`));
}

function findWebRoot(dir) {
  for (const w of ['web', 'public', '.']) {
    if (fs.existsSync(path.join(dir, w, 'index.html'))) return w;
  }
  return 'web';
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p) => fs.existsSync(p);

// Vercel counts one Serverless Function per file in api/ and the Hobby plan
// stops a deployment above this many. Sites at the cap park extra handlers in
// OFFLOADED_DIR (see handlerDest) behind a single dispatcher in api/.
const HOBBY_FUNCTION_CAP = 12;

// A handler is wired whether it sits in api/ or has been offloaded.
const hasHandler = (dir, apiAbs, name) =>
  exists(path.join(apiAbs, `${name}.js`)) || exists(path.join(dir, OFFLOADED_DIR, `${name}.js`));

function doctor(dir) {
  const web = findWebRoot(dir);
  const webAbs = path.join(dir, web);
  const apiAbs = path.join(dir, 'api');
  console.log(`${C.b}Plater doctor${C.x} ${C.d}${path.resolve(dir)} (web=${web}/)${C.x}\n`);

  const html = fs.existsSync(webAbs) ? fs.readdirSync(webAbs).filter((f) => f.endsWith('.html')).map((f) => read(path.join(webAbs, f))).join('\n') : '';
  const appjs = read(path.join(webAbs, 'app.js'));

  const checks = [
    ['client: plater-core.js vendored', exists(path.join(webAbs, 'plater-core.js')) || exists(path.join(webAbs, 'zms-core.js'))],
    ['client: initPlater()/initZMS() called', /init(?:Plater|ZMS)\s*\(/.test(appjs)],
    ['client: plater-capture.js vendored', exists(path.join(webAbs, 'plater-capture.js')) || exists(path.join(webAbs, 'zms-capture.js')), 'note→agent optional'],
    ['client: initCapture() called', /initCapture\s*\(/.test(appjs), 'note→agent optional'],
    ['markup: #cms-bar present', /id=["\']cms-bar["\']/.test(html)],
    ['markup: data-bind bindings present', /data-bind=/.test(html)],
    ['content: content/site.json', exists(path.join(webAbs, 'content', 'site.json')), 'the copy the page renders — elsewhere only if GITHUB_EDIT_PATH says so'],
    ['api/config.js', exists(path.join(apiAbs, 'config.js'))],
    ['api/content.js', exists(path.join(apiAbs, 'content.js'))],
    ['api/save.js', exists(path.join(apiAbs, 'save.js'))],
    // Offloaded handlers still count as wired: a site at the Vercel Hobby
    // function cap keeps these in lib/plater/ behind one dispatcher.
    ['handler: history.js', hasHandler(dir, apiAbs, 'history'), 'history + one-click restore optional'],
    ['handler: upload.js', hasHandler(dir, apiAbs, 'upload'), 'drag-and-drop image uploads optional'],
    ['api/agent-note.js', exists(path.join(apiAbs, 'agent-note.js')), 'note→agent optional'],
    ['api/review.js', exists(path.join(apiAbs, 'review.js')), 'sitemap review optional'],
    ['vercel.json', exists(path.join(dir, 'vercel.json')), 'feeds/sitemap/404 routing — Vercel hosts only'],
  ];
  let hard = 0;
  for (const [label, pass, opt] of checks) {
    console.log(pass ? ok(label) : (opt ? warn(`${label} ${C.d}(${opt})${C.x}`) : no(label)));
    if (!pass && !opt) hard++;
  }

  // The Vercel Hobby function cap, checked BEFORE a deploy rather than after.
  // Going over it fails at patchBuild with exceeded_serverless_functions_per_
  // deployment — a failure mode that hides itself, because production keeps
  // serving the last good deploy while every new commit silently stops
  // shipping. Only a file in api/ is a function; lib/plater/ handlers are not.
  if (exists(path.join(dir, 'vercel.json'))) {
    const fns = exists(apiAbs) ? fs.readdirSync(apiAbs).filter((f) => /\.(js|mjs|ts)$/.test(f)) : [];
    if (fns.length > HOBBY_FUNCTION_CAP) {
      console.log(no(`api/ has ${fns.length} functions — Vercel Hobby allows ${HOBBY_FUNCTION_CAP}; deploys will fail at patchBuild`));
      console.log(`  ${C.d}Move the extras to ${OFFLOADED_DIR}/ behind one dispatcher in api/, and rewrite to it in vercel.json.${C.x}`);
      hard++;
    } else if (fns.length === HOBBY_FUNCTION_CAP) {
      console.log(warn(`api/ is at the Vercel Hobby cap (${fns.length}/${HOBBY_FUNCTION_CAP}) ${C.d}— the next handler must be offloaded to ${OFFLOADED_DIR}/${C.x}`));
    } else {
      console.log(ok(`api/ functions ${fns.length}/${HOBBY_FUNCTION_CAP} ${C.d}(Vercel Hobby cap)${C.x}`));
    }
  }
  console.log(`\n${C.b}Env checklist${C.x} ${C.d}(set in Vercel; leave editing off by omitting auth)${C.x}`);
  for (const [k, desc] of ENV) console.log(`  ${C.d}${k.padEnd(22)}${C.x} ${desc}`);
  console.log(`\n${hard === 0 ? ok('wiring looks complete') : no(`${hard} required piece(s) missing`)} — editing still gated on env (token or Google).`);
  process.exit(hard === 0 ? 0 : 1);
}

// Host config and docs belong at the project root; the rest of the starter is
// the page itself and belongs in the web root — the same directory for a fresh
// site, web/ or public/ for one that already has a layout.
const PROJECT_FILES = new Set(['vercel.json', '.env.example', 'README.md']);

// An existing web root, or the project root for a fresh site. NOT findWebRoot()
// — its web/ fallback would bury a brand-new starter one level down and leave
// the starter's own vercel.json (content/**, not web/content/**) lying.
function initWebRoot(dir) {
  for (const w of ['web', 'public']) if (exists(path.join(dir, w, 'index.html'))) return w;
  return '.';
}

// Copy the starter file by file. `init` is re-runnable and must never clobber a
// site's own index.html or content, so an existing destination is a skip, and
// skips are reported — a silent one reads as "init did nothing".
function copyStarter(dir, webAbs) {
  const written = [], skipped = [];
  const walk = (src, dst, nested) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const to = path.join(nested ? dst : (PROJECT_FILES.has(ent.name) ? dir : webAbs), ent.name);
      if (ent.isDirectory()) { walk(path.join(src, ent.name), to, true); continue; }
      if (exists(to)) { skipped.push(path.relative(dir, to)); continue; }
      fs.copyFileSync(path.join(src, ent.name), to);
      written.push(path.relative(dir, to));
    }
  };
  walk(STARTER, webAbs, false);
  return { written, skipped };
}

function init(dir) {
  if (!exists(path.join(STARTER, 'index.html'))) { console.log(no(`starter template missing at ${STARTER}`)); process.exit(1); }
  const web = initWebRoot(dir);
  const webAbs = path.join(dir, web);
  const apiAbs = path.join(dir, 'api');
  fs.mkdirSync(webAbs, { recursive: true });
  fs.mkdirSync(apiAbs, { recursive: true });

  // 1. the site itself: a page that already renders, with content beside it
  const { written, skipped } = copyStarter(dir, webAbs);

  // 2. vendor client modules
  fs.copyFileSync(path.join(PKG, 'core/src/editor.js'), path.join(webAbs, 'plater-core.js'));
  fs.writeFileSync(path.join(webAbs, 'zms-core.js'), `export { default, initPlater, initZMS } from './plater-core.js';\n`);
  fs.copyFileSync(path.join(PKG, 'capture/src/capture.js'), path.join(webAbs, 'plater-capture.js'));
  fs.writeFileSync(path.join(webAbs, 'zms-capture.js'), `export { default, initCapture } from './plater-capture.js';\n`);

  // 3. scaffold api handlers as re-exports of the vendored server package
  const added = [];
  for (const name of HANDLERS) {
    const dst = path.join(apiAbs, `${name}.js`);
    if (!exists(dst)) { fs.copyFileSync(path.join(PKG, 'server-node', `${name}.js`), dst); added.push(`api/${name}.js`); }
  }

  if (written.length) console.log(ok(`wrote ${written.length} starter file(s): ${written.slice(0, 6).join(', ')}${written.length > 6 ? ', …' : ''}`));
  if (skipped.length) console.log(warn(`kept your existing ${skipped.join(', ')} ${C.d}(never overwritten)${C.x}`));
  console.log(ok(`vendored plater-core.js + plater-capture.js into ${web}/`));
  console.log(ok(added.length ? `scaffolded ${added.length} handler(s) in api/` : 'api/ handlers already present'));
  const at = dir === '.' ? '' : ` ${dir}`;
  console.log(`\n${C.b}Next:${C.x}`);
  console.log(`  1. platercms dev${at || ' .'} ${C.d}—${C.x} edit at http://127.0.0.1:4188/?edit ${C.d}(no auth; Save writes ${path.join(web === '.' ? '' : web, 'content/site.json')})${C.x}`);
  console.log(`  2. Copy .env.example → .env and set CMS_EDIT_TOKEN, then: platercms serve${at || ' .'} ${C.d}(auth on)${C.x}`);
  console.log(`  3. platercms doctor${at || ' .'} ${C.d}— what's wired, plus the env every host needs${C.x}`);
  console.log(`  4. Push to GitHub, import on Vercel: vercel.json already routes feeds, sitemap, llms.txt, and the editable 404.`);
}

// Server handlers scaffolded by `init` and kept in lockstep by `sync`.
// Single source of truth — add new handlers here only.
const HANDLERS = ['config', 'content', 'save', 'history', 'upload', 'agent-note', 'review', 'feed', 'sitemap', 'route', 'manifest', 'propose-post', 'versions'];

// Where a site keeps handlers it has moved OUT of api/. Vercel's Hobby plan
// caps a deployment at 12 Serverless Functions and counts one per file in api/,
// so a site at the cap fronts the extras with a single dispatcher and parks
// their bodies here. The bodies are still ours and still synced — only the
// directory differs.
const OFFLOADED_DIR = path.join('lib', 'plater');

// A handler's home in THIS site: api/ normally, lib/plater/ if the site has
// already moved it there. Sync follows the site's layout instead of imposing
// one, so re-syncing a capped site can never silently re-create the extra
// function file and break its deploys again.
function handlerDest(dir, name) {
  const offloaded = path.join(OFFLOADED_DIR, `${name}.js`);
  if (exists(path.join(dir, offloaded))) return offloaded;
  return path.join('api', `${name}.js`);
}

// Files kept in lockstep between this repo and consuming sites.
const SYNC_MAP = [
  ['core/src/editor.js', (web) => path.join(web, 'plater-core.js')],
  ['capture/src/capture.js', (web) => path.join(web, 'plater-capture.js')],
  ...HANDLERS.map((h) => [`server-node/${h}.js`, (web, dir) => handlerDest(dir, h)]),
];
const COMPAT_SYNC_MAP = [
  [(web) => path.join(web, 'zms-core.js'), (web) => `export { default, initPlater, initZMS } from './${path.basename(path.join(web, 'plater-core.js'))}';\n`],
  [(web) => path.join(web, 'zms-capture.js'), (web) => `export { default, initCapture } from './${path.basename(path.join(web, 'plater-capture.js'))}';\n`],
];
const MANIFEST = '.plater-sync.json';
const OLD_MANIFEST = '.zms-sync.json';

function readSyncManifest(dir) {
  for (const name of [MANIFEST, OLD_MANIFEST]) {
    const text = read(path.join(dir, name));
    if (text) {
      try { return { name, data: JSON.parse(text) }; } catch { return { name, data: null }; }
    }
  }
  return { name: null, data: null };
}

function sync(dir) {
  const web = findWebRoot(dir);
  readSyncManifest(dir);
  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: path.resolve(HERE, '..') }).toString().trim();
  } catch {}
  const synced = [];
  for (const [src, dstFn] of SYNC_MAP) {
    const dstRel = dstFn(web, dir);
    const dstAbs = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    const body = read(path.join(PKG, src));
    if (!body) { console.log(no(`missing source ${src}`)); process.exit(1); }
    const banner = `// GENERATED by \`plater sync\` from zachphillips/plater@${sha} (packages/${src})\n// DO NOT EDIT HERE — edit in ~/Dev/plater and re-run: node ~/Dev/plater/cli/plater.js sync .\n`;
    fs.writeFileSync(dstAbs, banner + body);
    synced.push(dstRel);
    console.log(ok(`synced ${dstRel}`));
  }
  for (const [dstFn, bodyFn] of COMPAT_SYNC_MAP) {
    const dstRel = dstFn(web);
    const dstAbs = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.writeFileSync(dstAbs, bodyFn(web));
    synced.push(dstRel);
    console.log(ok(`synced ${dstRel} compatibility shim`));
  }
  const manifest = { source: 'zachphillips/plater', commit: sha, synced: new Date().toISOString(), files: synced };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  try { fs.rmSync(path.join(dir, OLD_MANIFEST)); } catch {}
  console.log(ok(`${MANIFEST} manifest written (source @${sha})`));
  console.log(`${C.d}Run plater doctor to verify wiring; commit the synced files with the site.${C.x}`);
}

// The fleet answer to "how do updates reach every site without npm": each
// consuming site carries .plater-sync.json naming the commit it was synced
// from. `fleet` walks a root for those manifests, shows drift against this
// repo's HEAD, and with --sync re-runs sync() on every drifted site. The
// commit-and-push stays per-site and human-reviewed — this only refreshes
// working trees.
function fleet(root, doSync) {
  const rootAbs = path.resolve(root || path.join(process.env.HOME, 'Dev'));
  let head = 'unknown';
  try { head = execSync('git rev-parse --short HEAD', { cwd: path.resolve(HERE, '..') }).toString().trim(); } catch {}
  const skip = /node_modules|\.git\/|worktrees|orphan-landings|\/v1\//;
  const found = [];
  (function walk(d, depth) {
    if (depth > 4 || skip.test(d)) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && (e.name === MANIFEST || e.name === OLD_MANIFEST)) found.push(path.dirname(p));
      else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, depth + 1);
    }
  })(rootAbs, 0);
  if (!found.length) { console.log(no(`no ${MANIFEST} manifests under ${rootAbs}`)); process.exit(1); }
  console.log(`${C.b}Plater fleet${C.x} ${C.d}${found.length} site(s) under ${rootAbs} · plater HEAD @${head}${C.x}\n`);
  let drifted = 0;
  for (const siteDir of found.sort()) {
    const { data } = readSyncManifest(siteDir);
    const at = data && data.commit ? data.commit : '???';
    const current = at === head;
    if (!current) drifted++;
    console.log(current ? ok(`${siteDir} ${C.d}@${at}${C.x}`) : warn(`${siteDir} ${C.d}@${at} → ${head}${C.x}`));
    if (!current && doSync) {
      try { sync(siteDir); } catch (e) { console.log(no(`  sync failed: ${e.message}`)); }
    }
  }
  if (!doSync) console.log(`\n${drifted ? warn(`${drifted} site(s) behind — run: platercms fleet ${root || ''} --sync`) : ok('fleet is current')}`);
  else console.log(`\n${ok('fleet synced')} — review each site's diff, then commit and deploy per site.`);
}

const [, , cmd, dir = '.'] = process.argv;
if (cmd === 'doctor') doctor(dir);
else if (cmd === 'init') init(dir);
else if (cmd === 'sync') sync(dir);
else if (cmd === 'fleet') fleet(process.argv[3] === '--sync' ? undefined : dir, process.argv.includes('--sync'));
else if (cmd === 'publish') publish(dir).catch((e) => { console.error(no(e.message)); process.exit(1); });
else if (cmd === 'dev') import('./dev.mjs'); // serves dir from process.argv[2] itself
else if (cmd === 'serve') import('./serve.mjs'); // same, with auth on
else if (cmd === 'deploy-amber') import('./deploy-amber.mjs'); // ships dir to Amber forever-hosting (undocumented; fleet-internal)
else { console.log('usage: platercms <init|dev|serve|doctor|sync|fleet|publish> [dir]'); process.exit(1); }
