#!/usr/bin/env node
// create-platercms — `npm create platercms my-site`, the front door.
//
// Lays down a site that RUNS on the next command: the starter page, its
// content, the client editor, and every api/ handler — as VENDORED COPIES,
// not dependencies. The scaffolded site has no node_modules, no package.json
// it must install, and no build step; it is plain files you own and commit.
// (Same payload `platercms init` writes, from the same sources — see
// copy-template.mjs, which refills this package's bundle on prepack.)
//
//   npm create platercms my-site      scaffold into ./my-site
//   npm create platercms              scaffold into the current directory
//   npm create platercms . --force    scaffold into a directory that has files
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved against THIS file, never cwd — the CLI runs from the target dir or
// out of an npx cache, so a relative payload path would miss.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..'); // only exists in a plater checkout

// Bundled payload when published; the monorepo sources when run from a
// checkout that has not been packed yet. Same bytes either way.
const pick = (bundled, source) => (fs.existsSync(bundled) ? bundled : source);
const TEMPLATE = pick(path.join(HERE, 'template'), path.join(REPO, 'templates', 'starter'));
const CLIENT = pick(path.join(HERE, 'vendor', 'client'), null);
const API = pick(path.join(HERE, 'vendor', 'api'), null);
const PKG = path.join(REPO, 'packages');

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (s) => console.log(`${C.g}✓${C.x} ${s}`);
const die = (s, hint) => { console.error(`${C.r}✗${C.x} ${s}`); if (hint) console.error(`  ${C.d}${hint}${C.x}`); process.exit(1); };

// Handlers scaffolded into api/. Mirrors cli/plater.js's HANDLERS; when the
// bundle is present the directory listing IS the list, so a handler added
// upstream ships without editing this file.
const HANDLERS = ['config', 'content', 'save', 'history', 'upload', 'agent-note', 'review', 'feed', 'sitemap', 'route', 'manifest', 'propose-post', 'versions'];

// npm passes flags through after the dir; accept them in any order.
const argv = process.argv.slice(2);
const force = argv.includes('--force') || argv.includes('-f');
const target = path.resolve(argv.find((a) => !a.startsWith('-')) || '.');

// A path the reader can paste. Relative while it stays under cwd; the moment
// it climbs out ("../../tmp/x") the absolute form is the shorter true answer.
function display(abs) {
  const under = path.relative(process.cwd(), abs);
  return !under ? '.' : under.startsWith('..') ? abs : under;
}

// Housekeeping files never mean "occupied" — a `git init`'d empty dir is the
// most common starting point there is.
const IGNORED = new Set(['.git', '.DS_Store', '.gitkeep', 'Thumbs.db']);

function assertEmpty(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((n) => !IGNORED.has(n)); } catch { return; }
  if (!entries.length || force) return;
  const shown = entries.slice(0, 5).join(', ');
  die(
    `${display(dir)} already has files (${shown}${entries.length > 5 ? `, +${entries.length - 5} more` : ''}).`,
    'Nothing was written. Pick an empty directory, or re-run with --force to write alongside them (existing files are still never overwritten).',
  );
}

function copyDir(src, dst, written) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name), to = path.join(dst, ent.name);
    if (ent.isDirectory()) { copyDir(from, to, written); continue; }
    if (fs.existsSync(to)) continue; // --force writes alongside, never over
    fs.copyFileSync(from, to);
    written.push(path.relative(target, to));
  }
}

function copyFile(from, to, written) {
  if (!fs.existsSync(from)) die(`missing bundled source ${from}`, 'This tarball is incomplete — please report it.');
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  written.push(path.relative(target, to));
}

if (!fs.existsSync(path.join(TEMPLATE, 'index.html'))) die(`starter template missing at ${TEMPLATE}`);
fs.mkdirSync(target, { recursive: true });
assertEmpty(target);

// 1. the site itself — a page that already renders, content beside it
const site = [];
copyDir(TEMPLATE, target, site);

// 2. the client editor, vendored (zms-* shims keep pre-rename sites' imports working)
const client = [];
copyFile(CLIENT ? path.join(CLIENT, 'plater-core.js') : path.join(PKG, 'core/src/editor.js'), path.join(target, 'plater-core.js'), client);
copyFile(CLIENT ? path.join(CLIENT, 'plater-capture.js') : path.join(PKG, 'capture/src/capture.js'), path.join(target, 'plater-capture.js'), client);
for (const [name, body] of [
  ['zms-core.js', `export { default, initPlater, initZMS } from './plater-core.js';\n`],
  ['zms-capture.js', `export { default, initCapture } from './plater-capture.js';\n`],
]) {
  const to = path.join(target, name);
  if (!fs.existsSync(to)) { fs.writeFileSync(to, body); client.push(name); }
}

// 3. api/ handlers, vendored — the same code Vercel runs in production
const api = [];
const names = API ? fs.readdirSync(API).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort() : HANDLERS;
for (const name of names) {
  copyFile(API ? path.join(API, `${name}.js`) : path.join(PKG, 'server-node', `${name}.js`), path.join(target, 'api', `${name}.js`), api);
}

// A re-run (only reachable under --force) writes nothing and must say so —
// "0 files" reads as a failure when it means "already exactly right".
const rel = display(target);
ok(site.length ? `site scaffolded in ${rel}/ ${C.d}(${site.length} starter file(s))${C.x}` : `site already in ${rel}/ ${C.d}(kept every existing file)${C.x}`);
ok(client.length ? `vendored plater-core.js + plater-capture.js ${C.d}(no npm install — they are yours now)${C.x}` : 'client modules already vendored');
ok(api.length ? `${api.length} api/ handler(s) written` : 'api/ handlers already present');

console.log(`\n${C.b}Next:${C.x}`);
if (rel !== '.') console.log(`  1. cd ${rel}`);
console.log(`  ${rel !== '.' ? 2 : 1}. npx platercms dev .   ${C.d}— edit at http://127.0.0.1:4188/?edit (no auth; Save writes content/site.json)${C.x}`);
console.log(`  ${rel !== '.' ? 3 : 2}. npx platercms doctor . ${C.d}— what's wired, plus the env every host needs${C.x}`);
console.log(`\n${C.d}There is nothing to install: no package.json, no node_modules, no build step.`);
console.log(`Everything above runs through npx. Push to GitHub and import on Vercel when you're ready —`);
console.log(`vercel.json already routes feeds, sitemap, llms.txt, and the editable 404.${C.x}`);
