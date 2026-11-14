// The disk leg of the content merge contract, over real HTTP. Concurrent
// saves must preserve sibling fields and refuse competing edits to one field.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDev } from '../cli/dev.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-save-dev-'));
fs.cpSync(path.join(root, 'examples/static-site'), dir, { recursive: true });
const served = await startDev(dir, { port: Number(process.env.PORT) || 24185 });
const url = `http://127.0.0.1:${served.port}/api/save`;
const read = () => JSON.parse(fs.readFileSync(served.contentPath, 'utf8'));
const results = [];
async function post(body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
function check(ok, what, detail) {
  results.push({ ok, what, detail });
  console.log(JSON.stringify(results.at(-1)));
}
try {
  const base = read();
  const a = structuredClone(base), b = structuredClone(base);
  a.hero.headline = 'First editor changes the headline';
  b.hero.subhead = 'Second editor changes its sibling';
  const concurrent = await Promise.all([post({ base, content: a }), post({ base, content: b })]);
  const stored = read();
  check(concurrent.every((r) => r.status === 200) && stored.hero.headline === a.hero.headline && stored.hero.subhead === b.hero.subhead,
    'simultaneous sibling edits survive in the real file', { statuses: concurrent.map((r) => r.status), hero: stored.hero });
  const c = structuredClone(stored), d = structuredClone(stored);
  c.hero.headline = 'One competing headline'; d.hero.headline = 'Another competing headline';
  const collisions = await Promise.all([post({ base: stored, content: c }), post({ base: stored, content: d })]);
  check(collisions.map((r) => r.status).sort().join(',') === '200,409', 'competing same-field writes leave one committed value and one explicit conflict', collisions.map((r) => r.status));
  const live = read();
  const overlayDir = path.join(path.dirname(served.contentPath), 'versions', 'scratch');
  fs.mkdirSync(overlayDir, { recursive: true });
  fs.writeFileSync(path.join(overlayDir, 'site.json'), JSON.stringify({ hero: { headline: 'Existing sparse draft headline' } }));
  const rendered = await (await fetch(`http://127.0.0.1:${served.port}/api/content?track=scratch`)).json();
  const draft = structuredClone(rendered);
  draft.tools[0].desc = 'An edit in another part of the sparse draft';
  const draftSave = await post({ base: rendered, content: draft, track: 'scratch' });
  check(draftSave.status === 200 && draftSave.body.content.hero.headline === rendered.hero.headline && draftSave.body.content.hero.subhead === live.hero.subhead,
    'sparse draft save preserves inherited copy and existing draft fields', draftSave.body.content.hero);
} finally {
  await new Promise((resolve) => served.server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
