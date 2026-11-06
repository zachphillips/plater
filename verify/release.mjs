// npm run verify:release — run the real release-facing tools and read what they
// produce. Three checks, each driving the actual thing a user or the release
// workflow runs:
//
//   doctor   `platercms doctor` on a freshly wired site (and on a pre-rename
//            zms-* site, the alias contract) exits 0 and says the wiring is
//            complete, with the PLATER_ env names in its checklist.
//   publish  publishSite() turns a fixture content tree (markdown + html pages,
//            folders, permalinks, redirects) into real files under web/.
//   pack     `npm pack --dry-run` for every package release.yml publishes: the
//            tarball holds the bin, LICENSE, README and every exported file,
//            nothing release.yml publishes is private, and the bundled
//            create-platercms template matches templates/starter byte for byte.
//
// These only break after `npm publish`, which is the worst time to find out,
// so release.yml runs this before publishing. No dependencies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishSite } from '../packages/server-node/publish.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${String(detail).split('\n').slice(0, 8).join('\n     ')}` : ''}`);
  if (!ok) failures++;
}

/* ---------------- doctor ---------------- */

function wireSite({ core, capture, init }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-verify-doctor-'));
  fs.mkdirSync(path.join(dir, 'api'));
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<div id="cms-bar"></div><main data-bind="title">Hello</main>\n');
  fs.writeFileSync(path.join(dir, 'app.js'), `${init}(); initCapture();\n`);
  fs.writeFileSync(path.join(dir, core), '');
  fs.writeFileSync(path.join(dir, capture), '');
  fs.writeFileSync(path.join(dir, 'content', 'site.json'), '{}\n');
  for (const h of ['config', 'content', 'save', 'agent-note', 'review']) fs.writeFileSync(path.join(dir, 'api', `${h}.js`), '');
  return dir;
}

const root = read('package.json');
const bin = path.join(ROOT, root.bin.platercms);
for (const [label, wiring] of [
  ['plater-* wiring', { core: 'plater-core.js', capture: 'plater-capture.js', init: 'initPlater' }],
  ['deprecated zms-* wiring', { core: 'zms-core.js', capture: 'zms-capture.js', init: 'initZMS' }],
]) {
  const r = spawnSync(process.execPath, [bin, 'doctor', wireSite(wiring)], { cwd: ROOT, encoding: 'utf8' });
  check(r.status === 0 && /wiring looks complete/.test(r.stdout), `doctor: ${label} reports complete`, r.stderr || r.stdout);
  if (label.startsWith('plater')) {
    check(/PLATER_AGENT_ENDPOINT/.test(r.stdout) && /PLATER_AGENT_TOKEN/.test(r.stdout), 'doctor: env checklist names PLATER_ agent vars', r.stdout);
  }
}

/* ---------------- publish ---------------- */

const site = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-verify-publish-'));
const page = (rel, text) => { fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }); fs.writeFileSync(path.join(site, rel), text); };
page('content/pages/index.md', '---\ntitle: Home\n---\n# Home\n\nWelcome.\n');
page('content/pages/about.md', '---\ntitle: About\npermalink: /about-zach/\nredirects:\n  - /about/\n---\n# About\n');
page('content/pages/projects/index.md', '---\ntitle: Projects\n---\n# Projects\n\nFolder index.\n');
page('content/pages/projects/alpha.md', '---\ntitle: Alpha\n---\n# Alpha\n\n[plater-if logged-in]\nPrivate project notes.\n[/plater-if]\n');
page('content/pages/projects/beta.html', `<!doctype html><html><head><title>x</title>
<script type="application/json" data-plater-meta>{ "title": "Beta", "permalink": "/work/beta/", "redirects": ["/projects/beta/"] }</script>
</head><body><h1>Beta</h1></body></html>\n`);
const manifest = await publishSite({ cwd: site });
const routes = manifest.pages.map((p) => p.route).sort().join(' ');
check(routes === '/ /about-zach/ /projects/ /projects/alpha/ /work/beta/', 'publish: every page lands at its route', routes);
const out = (rel) => { try { return fs.readFileSync(path.join(site, 'web', rel), 'utf8'); } catch { return ''; } };
check(/<h1>Home<\/h1>/.test(out('index.html')) && /Folder index/.test(out('projects/index.html')), 'publish: markdown renders to HTML');
check(/url=\/about-zach\//.test(out('about/index.html')) && /url=\/work\/beta\//.test(out('projects/beta/index.html')), 'publish: old URLs redirect to permalinks');
const alpha = out('projects/alpha/index.html');
check(/data-plater-if="logged-in"/.test(alpha) && /body\.plater-logged-in/.test(alpha), 'publish: conditional content keeps its marker and runtime');
check(!/data-plater-meta/.test(out('work/beta/index.html')), 'publish: page metadata block is stripped from the HTML');

/* ---------------- pack ---------------- */

// Before any `npm pack`: create-platercms's prepack re-copies the template, so
// checking afterwards would only see the freshly copied bytes, not what is committed.
const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), path.join(base, e.name)) : [path.join(base, e.name)]);
const starter = path.join(ROOT, 'templates/starter');
const bundled = path.join(ROOT, 'packages/create-platercms/template');
const drift = [...new Set([...walk(starter), ...walk(bundled)])].filter((rel) => {
  try { return !fs.readFileSync(path.join(starter, rel)).equals(fs.readFileSync(path.join(bundled, rel))); } catch { return true; }
});
check(drift.length === 0, 'pack: create-platercms template matches templates/starter', `drifted: ${drift.join(', ')} (re-run packages/create-platercms/copy-template.mjs)`);

const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const loop = yml.match(/for dir in ([^;]+); do/);
check(Boolean(loop), 'pack: release.yml has its publish loop');
const published = loop ? loop[1].trim().split(/\s+/) : [];
for (const dir of published) {
  const pkg = read(path.join(dir, 'package.json'));
  check(pkg.private === undefined, `pack: ${dir} is publishable (not private)`);
  check(pkg.engines?.node === '>=20', `pack: ${pkg.name} declares engines.node >=20`);
  const args = ['pack', '--dry-run', '--json', ...(dir === '.' ? [] : ['--workspace', dir])];
  const r = spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  let files = [];
  // prepack scripts (create-platercms copies its template) print before the JSON.
  try { files = JSON.parse(r.stdout.slice(r.stdout.search(/^\[/m)))[0].files.map((f) => f.path); } catch {}
  check(r.status === 0 && files.length > 0, `pack: ${pkg.name} packs (${files.length} files)`, r.stderr);
  const want = ['LICENSE', 'README.md', 'package.json'];
  for (const target of Object.values(pkg.bin || {})) want.push(target);
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const target of Object.values(pkg.exports)) if (typeof target === 'string') want.push(target.replace(/^\.\//, ''));
  }
  const missing = want.filter((f) => !files.includes(f));
  check(missing.length === 0, `pack: ${pkg.name} tarball has its bin, exports, LICENSE and README`, `missing: ${missing.join(', ')}`);
  for (const target of Object.values(pkg.bin || {})) {
    const abs = path.join(ROOT, dir, target);
    check(/^#!\/usr\/bin\/env node/.test(fs.readFileSync(abs, 'utf8')) && (fs.statSync(abs).mode & 0o111) !== 0,
      `pack: ${pkg.name} bin ${target} has a node shebang and is executable`);
  }
  check(!('plater' in (pkg.bin || {})), `pack: ${pkg.name} does not claim the \`plater\` bin (taken on npm)`);
}

console.log(failures ? `\nverify:release FAILED (${failures})` : '\nverify:release passed');
process.exit(failures ? 1 : 0);
