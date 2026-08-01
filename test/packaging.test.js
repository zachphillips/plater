// The release contract. Everything here is a thing that only breaks AFTER
// `npm publish` has already happened, which is the worst time to find it —
// a bad bin, a missing file, or an unpublishable manifest ships silently and
// can't be unpublished cleanly. Cheap to assert, expensive to discover live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const root = read('package.json');

// The four tarballs the release workflow pushes, plus the root, which is the
// only one carrying the `platercms` bin.
const PUBLISHED = [
  '.',
  'packages/core',
  'packages/server-node',
  'packages/capture',
  'packages/create-platercms',
];

test('release.yml publishes exactly the packages that are not private', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const loop = yml.match(/for dir in ([^;]+); do/);
  assert.ok(loop, 'release.yml must have a `for dir in ... ; do` publish loop');
  const listed = loop[1].trim().split(/\s+/);

  for (const dir of PUBLISHED) {
    assert.ok(listed.includes(dir), `${dir} is publishable but release.yml never publishes it`);
  }
  for (const dir of listed) {
    assert.equal(read(path.join(dir, 'package.json')).private, undefined,
      `release.yml publishes ${dir}, which is marked private`);
  }
});

test('the platercms CLI bin exists, is executable, and ships in the tarball', () => {
  assert.equal(root.private, undefined, 'the root package carries the bin — it cannot be private');
  const bin = root.bin?.platercms;
  assert.ok(bin, '`platercms` is the documented command; it must be a bin key');

  const abs = path.join(ROOT, bin);
  assert.ok(fs.existsSync(abs), `bin target ${bin} does not exist`);
  assert.match(fs.readFileSync(abs, 'utf8'), /^#!\/usr\/bin\/env node/, 'bin needs a node shebang');
  assert.ok(fs.statSync(abs).mode & 0o111, `${bin} is not executable`);

  // `files` is an allowlist: anything not covered is absent from the tarball,
  // so the bin resolving locally proves nothing about the published package.
  assert.ok(root.files?.some((f) => bin === f || bin.startsWith(f.replace(/\/$/, '') + '/')),
    `${bin} is not covered by the root "files" allowlist ${JSON.stringify(root.files)}`);
});

// `plater` is taken on npm by an unrelated package that declares its own
// `plater` bin, so claiming that alias would collide on install.
test('no package claims the `plater` bin name', () => {
  for (const dir of PUBLISHED) {
    const bin = read(path.join(dir, 'package.json')).bin;
    if (bin && typeof bin === 'object') {
      assert.ok(!('plater' in bin), `${dir} claims the \`plater\` bin, which is taken on npm`);
    }
  }
});

test('every published package ships its own LICENSE and README', () => {
  // npm only auto-includes these from the package's OWN directory; the root
  // LICENSE is not inherited by a workspace.
  for (const dir of PUBLISHED) {
    for (const name of ['LICENSE', 'README.md']) {
      assert.ok(fs.existsSync(path.join(ROOT, dir, name)), `${dir}/${name} is missing`);
    }
  }
});

test('published manifests carry repository.directory, engines, and clean bin paths', () => {
  for (const dir of PUBLISHED) {
    const p = read(path.join(dir, 'package.json'));
    assert.equal(p.engines?.node, '>=20', `${dir} must declare engines.node`);
    if (dir !== '.') {
      assert.equal(p.repository?.directory, dir, `${dir} needs repository.directory for npm's source link`);
    }
    // A leading "./" makes npm rewrite the manifest at publish time and warn.
    for (const target of Object.values(p.bin || {})) {
      assert.doesNotMatch(target, /^\.\//, `${dir} bin "${target}" must not start with "./"`);
    }
  }
});

test('every server-node exports subpath is a real file and is in `files`', () => {
  const p = read('packages/server-node/package.json');
  for (const [sub, target] of Object.entries(p.exports)) {
    const rel = target.replace(/^\.\//, '');
    assert.ok(fs.existsSync(path.join(ROOT, 'packages/server-node', rel)), `exports ${sub} -> missing ${rel}`);
    assert.ok(p.files.includes(rel), `exports ${sub} -> ${rel} is not in "files", so it won't ship`);
  }
});

test('lint covers every directory that holds shipped JavaScript', () => {
  const lint = root.scripts.lint;
  // templates/ is the canonical starter — the file every new user edits first.
  for (const dir of ['cli', 'examples', 'packages', 'templates', 'test']) {
    assert.match(lint, new RegExp(`\\b${dir}\\b`), `npm run lint does not cover ${dir}/`);
  }
});

// The identity swap has to be complete in the bytes that reach a user: the
// scaffolded site's own source and the marketing page.
test('no `@plater/` scope survives in shipped files', () => {
  const shipped = [
    'templates/starter/app.js',
    'packages/create-platercms/template/app.js',
    'docs/index.html',
  ];
  for (const rel of shipped) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /@plater\//, `${rel} still references the old @plater/ scope`);
  }
});

// agent-note is the one handler whose env had no PLATER_ name to migrate to.
test('the PLATER_ env names are what users are told to set', () => {
  const agentNote = fs.readFileSync(path.join(ROOT, 'packages/server-node/agent-note.js'), 'utf8');
  assert.match(agentNote, /process\.env\.PLATER_AGENT_ENDPOINT \|\| process\.env\.ZMS_AGENT_ENDPOINT/);
  assert.match(agentNote, /process\.env\.PLATER_AGENT_TOKEN \|\| process\.env\.ZMS_AGENT_TOKEN/);

  for (const rel of ['templates/starter/.env.example', 'packages/create-platercms/template/.env.example']) {
    const env = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(env, /^PLATER_AGENT_ENDPOINT=/m, `${rel} must document the PLATER_ name`);
    assert.doesNotMatch(env, /^ZMS_AGENT_/m, `${rel} must not tell a new user to set a ZMS_ variable`);
  }
});

// The bundled template is a derived copy; a drifted one ships stale bytes.
test('the create-platercms template matches the canonical starter', () => {
  const a = path.join(ROOT, 'templates/starter');
  const b = path.join(ROOT, 'packages/create-platercms/template');
  const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), path.join(base, e.name)) : [path.join(base, e.name)]);

  const names = walk(a).sort();
  assert.deepEqual(names, walk(b).sort(), 'template/ and templates/starter/ have different files');
  for (const rel of names) {
    assert.deepEqual(fs.readFileSync(path.join(b, rel)), fs.readFileSync(path.join(a, rel)),
      `${rel} has drifted from the canonical starter — re-run packages/create-platercms/copy-template.mjs`);
  }
});
