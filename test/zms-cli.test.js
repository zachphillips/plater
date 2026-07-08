import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const binPath = path.join(repoRoot, pkg.bin.zms);

test('zms doctor reports a fully wired site as healthy', () => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zms-smoke-'));
  fs.mkdirSync(path.join(siteDir, 'api'));

  fs.writeFileSync(
    path.join(siteDir, 'index.html'),
    '<div id="cms-bar"></div><main data-bind="title">Hello</main>\n',
  );
  fs.writeFileSync(path.join(siteDir, 'app.js'), 'initZMS(); initCapture();\n');
  fs.writeFileSync(path.join(siteDir, 'zms-core.js'), '');
  fs.writeFileSync(path.join(siteDir, 'zms-capture.js'), '');
  for (const handler of ['config', 'content', 'save', 'agent-note', 'review']) {
    fs.writeFileSync(path.join(siteDir, 'api', `${handler}.js`), '');
  }

  const result = spawnSync(process.execPath, [binPath, 'doctor', siteDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /(ZMS|Plater) doctor/);
  assert.match(result.stdout, /wiring looks complete/);
});
