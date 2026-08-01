// copy-template — refill this package's bundled payload from the monorepo.
// Runs on `prepack`, so the published tarball always carries the CANONICAL
// starter and the CANONICAL client/server sources, never a stale fork:
//
//   ../../templates/starter        -> ./template   (the site itself)
//   ../../packages/core/src        -> ./vendor/client/plater-core.js
//   ../../packages/capture/src     -> ./vendor/client/plater-capture.js
//   ../../packages/server-node/*   -> ./vendor/api/<handler>.js
//
// The handler list is read out of cli/plater.js rather than restated here —
// `init` and `npm create` must scaffold the same set or sites drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const STARTER = path.join(REPO, 'templates', 'starter');
const PKG = path.join(REPO, 'packages');

const die = (msg) => { console.error(`create-platercms: ${msg}`); process.exit(1); };

// Sole source of truth for what an api/ dir contains: cli/plater.js's HANDLERS.
function handlerNames() {
  const cli = path.join(REPO, 'cli', 'plater.js');
  let src;
  try { src = fs.readFileSync(cli, 'utf8'); } catch { die(`cannot read ${cli}`); }
  const m = src.match(/const HANDLERS = \[([^\]]*)\]/);
  if (!m) die('could not find the HANDLERS list in cli/plater.js — sync the scaffolders by hand');
  const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (!names.length) die('HANDLERS list in cli/plater.js parsed empty');
  return names;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name), to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function replaceDir(src, dst) {
  if (!fs.existsSync(src)) die(`missing source ${src} — run this from a plater checkout, not a published tarball`);
  fs.rmSync(dst, { recursive: true, force: true });
  copyDir(src, dst);
}

replaceDir(STARTER, path.join(HERE, 'template'));

const client = path.join(HERE, 'vendor', 'client');
fs.rmSync(path.join(HERE, 'vendor'), { recursive: true, force: true });
fs.mkdirSync(client, { recursive: true });
fs.copyFileSync(path.join(PKG, 'core', 'src', 'editor.js'), path.join(client, 'plater-core.js'));
fs.copyFileSync(path.join(PKG, 'capture', 'src', 'capture.js'), path.join(client, 'plater-capture.js'));

const api = path.join(HERE, 'vendor', 'api');
fs.mkdirSync(api, { recursive: true });
const names = handlerNames();
for (const name of names) {
  const from = path.join(PKG, 'server-node', `${name}.js`);
  if (!fs.existsSync(from)) die(`handler ${name}.js listed in cli/plater.js but missing from packages/server-node`);
  fs.copyFileSync(from, path.join(api, `${name}.js`));
}

const files = fs.readdirSync(path.join(HERE, 'template')).length;
console.log(`create-platercms: template/ (${files} entries), vendor/client (2), vendor/api (${names.length} handlers)`);
