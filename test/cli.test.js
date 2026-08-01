import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// `platercms` is the published command — the one every doc tells a user to run,
// so pin it by name. A missing key here means `npx platercms` would 404.
assert.ok(pkg.bin?.platercms, 'package.json must expose the `platercms` bin');
assert.equal(pkg.private, undefined, 'the root package must be publishable — it carries the CLI bin');
const binPath = path.join(repoRoot, pkg.bin.platercms);

// A site wired the way `platercms init` writes one today.
function wireSite(prefix, { core, capture, init }) {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(siteDir, 'api'));
  fs.mkdirSync(path.join(siteDir, 'content'));
  fs.writeFileSync(
    path.join(siteDir, 'index.html'),
    '<div id="cms-bar"></div><main data-bind="title">Hello</main>\n',
  );
  fs.writeFileSync(path.join(siteDir, 'app.js'), `${init}(); initCapture();\n`);
  fs.writeFileSync(path.join(siteDir, core), '');
  fs.writeFileSync(path.join(siteDir, capture), '');
  fs.writeFileSync(path.join(siteDir, 'content', 'site.json'), '{}\n');
  for (const handler of ['config', 'content', 'save', 'agent-note', 'review']) {
    fs.writeFileSync(path.join(siteDir, 'api', `${handler}.js`), '');
  }
  return siteDir;
}

const doctor = (siteDir) =>
  spawnSync(process.execPath, [binPath, 'doctor', siteDir], { cwd: repoRoot, encoding: 'utf8' });

test('platercms doctor reports a fully wired site as healthy', () => {
  const siteDir = wireSite('plater-smoke-', {
    core: 'plater-core.js',
    capture: 'plater-capture.js',
    init: 'initPlater',
  });
  const result = doctor(siteDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Plater doctor/);
  assert.match(result.stdout, /wiring looks complete/);
});

// The alias contract: a site vendored before the rename must still pass clean.
test('platercms doctor still accepts the deprecated zms-* wiring', () => {
  const siteDir = wireSite('plater-smoke-zms-', {
    core: 'zms-core.js',
    capture: 'zms-capture.js',
    init: 'initZMS',
  });
  const result = doctor(siteDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /wiring looks complete/);
});

test('the doctor env checklist advertises the PLATER_ agent names', () => {
  const siteDir = wireSite('plater-smoke-env-', {
    core: 'plater-core.js',
    capture: 'plater-capture.js',
    init: 'initPlater',
  });
  const result = doctor(siteDir);

  assert.match(result.stdout, /PLATER_AGENT_ENDPOINT/);
  assert.match(result.stdout, /PLATER_AGENT_TOKEN/);
});
