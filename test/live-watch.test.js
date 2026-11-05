// The /api/live watcher under the ways real files change: atomic saves,
// git checkout swapping a folder, repos with .git and node_modules, a
// public stream on plater serve, shutdown with streams open, and a single
// loose .html file served by plater dev.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createLiveHub } from '../packages/server-node/live.js';
import { startDev, serveStatic, singleFileServes } from '../cli/dev.mjs';
import { startServe } from '../cli/serve.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `plater-${p}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A hub with one fake client that records frames.
function hubOn(dir, opts = {}) {
  const hub = createLiveHub({ webRoot: dir, contentPath: path.join(dir, 'content', 'site.json'), debounceMs: 30, log: { warn() {} }, ...opts });
  const frames = [];
  const res = { writeHead() {}, write: (f) => frames.push(f), end() {} };
  hub.handle({ on() {} }, res);
  const events = () => frames.filter((f) => f.startsWith('event:')).map((f) => ({ type: /^event: (.*)$/m.exec(f)[1], data: /^data: (.*)$/m.exec(f)[1] }));
  return { hub, events };
}
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return false;
}

function site() {
  const dir = tmp('watch');
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'content', 'site.json'), '{}');
  fs.writeFileSync(path.join(dir, 'styles.css'), 'a{}');
  return dir;
}

test('a file replaced by atomic save keeps streaming on every later save', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  const file = path.join(dir, 'content', 'site.json');
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(file + '.tmp', `{"n":${i}}`);
    fs.renameSync(file + '.tmp', file);
    assert.ok(await until(() => events().filter((e) => e.type === 'content' && e.data === 'content/site.json').length >= i), `save ${i} streamed`);
  }
  fs.writeFileSync(file, '{"n":4}');
  assert.ok(await until(() => events().filter((e) => e.type === 'content').length >= 4), 'a plain write after the renames still streams');
  hub.close();
});

test('a folder deleted and recreated (git checkout) is re-armed', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  await sleep(50);
  fs.rmSync(path.join(dir, 'content'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'content'));
  await sleep(150);
  fs.writeFileSync(path.join(dir, 'content', 'site.json'), '{"back":true}');
  assert.ok(await until(() => events().some((e) => e.type === 'content')), 'writes in the recreated folder stream');
  hub.close();
});

test('.git, dot-folders and node_modules are never watched', () => {
  const dir = site();
  for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(dir, '.git', 'objects', String(i)), { recursive: true });
  for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(dir, 'node_modules', `pkg${i}`, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'decks', 'one'), { recursive: true });
  const { hub } = hubOn(dir);
  assert.equal(hub.watched(), 4, 'root, content, decks, decks/one');
  hub.close();
});

test('contentOnly (plater serve) sends content events with no file names', async () => {
  const dir = site();
  fs.mkdirSync(path.join(dir, 'content', 'versions', 'secret-launch'), { recursive: true });
  const { hub, events } = hubOn(dir, { contentOnly: true });
  fs.writeFileSync(path.join(dir, 'styles.css'), 'b{}');
  fs.writeFileSync(path.join(dir, 'content', 'versions', 'secret-launch', 'site.json'), '{}');
  assert.ok(await until(() => events().some((e) => e.type === 'content')));
  await sleep(100);
  assert.ok(events().every((e) => e.type === 'content' && e.data === ''), JSON.stringify(events()));
  hub.close();
});

test('the stream refuses clients past the cap', () => {
  const dir = site();
  const hub = createLiveHub({ webRoot: dir, contentPath: path.join(dir, 'content', 'site.json'), maxClients: 2, log: { warn() {} } });
  const codes = [];
  for (let i = 0; i < 3; i++) hub.handle({ on() {} }, { writeHead: (c) => codes.push(c), write() {}, end() {} });
  assert.deepEqual(codes, [200, 200, 503]);
  hub.close();
});

test('plater dev serves a single loose .html file live, and closes with a stream open', async () => {
  const dir = tmp('loose');
  fs.writeFileSync(path.join(dir, 'Kitchen-Invoice.html'), '<!doctype html><body><h1>Invoice</h1></body>');
  const prev = process.cwd();
  const { server, port } = await startDev(path.join(dir, 'Kitchen-Invoice.html'), { port: 4720 });
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/Kitchen-Invoice.html');
    const page = await (await fetch(`http://127.0.0.1:${port}/Kitchen-Invoice.html`)).text();
    assert.match(page, /\/__plater\/live\.js/);
    // An open stream must not hold server.close() forever.
    await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/api/live`, resolve));
  } finally {
    const closed = await Promise.race([new Promise((r) => server.close(() => r(true))), sleep(2000).then(() => false)]);
    process.chdir(prev);
    assert.ok(closed, 'server.close() finished with a live stream open');
  }
});

test('plater dev lists a folder of loose pages with no index.html', async () => {
  const dir = tmp('folder');
  fs.writeFileSync(path.join(dir, 'acme-proposal.html'), '<p>p</p>');
  fs.writeFileSync(path.join(dir, 'acme-invoice.html'), '<p>i</p>');
  const prev = process.cwd();
  const { server, port } = await startDev(dir, { port: 4740 });
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /acme-invoice\.html/);
    assert.match(html, /acme-proposal\.html/);
  } finally {
    server.close();
    process.chdir(prev);
  }
});

test('a content folder swapped in whole (already holding a new site.json) streams content', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  await sleep(50);
  const next = path.join(dir, 'content.next');
  fs.mkdirSync(next);
  fs.writeFileSync(path.join(next, 'site.json'), '{"swapped":true}');
  fs.rmSync(path.join(dir, 'content'), { recursive: true });
  fs.renameSync(next, path.join(dir, 'content'));
  assert.ok(await until(() => events().some((e) => e.type === 'content' && e.data === 'content/site.json')), JSON.stringify(events()));
  hub.close();
});

test('a replaced web root is re-armed and announced', async () => {
  const parent = tmp('rootswap');
  const dir = path.join(parent, 'site');
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'content', 'site.json'), '{}');
  const { hub, events } = hubOn(dir);
  await sleep(50);
  const next = path.join(parent, 'site.next');
  fs.mkdirSync(path.join(next, 'content'), { recursive: true });
  fs.writeFileSync(path.join(next, 'content', 'site.json'), '{"v":2}');
  fs.rmSync(dir, { recursive: true });
  fs.renameSync(next, dir);
  assert.ok(await until(() => events().some((e) => e.type === 'content')), 'the swap itself was announced');
  const before = events().length;
  fs.writeFileSync(path.join(dir, 'content', 'site.json'), '{"v":3}');
  assert.ok(await until(() => events().length > before), 'and later writes still stream');
  hub.close();
});

test('single-file mode streams only the page and its stylesheets, never a sibling page', async () => {
  const dir = tmp('single');
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<p>i</p>');
  fs.writeFileSync(path.join(dir, 'other.html'), '<p>o</p>');
  fs.writeFileSync(path.join(dir, 'page.css'), 'a{}');
  fs.mkdirSync(path.join(dir, 'Projects', 'a', 'b', 'c'), { recursive: true });
  const { hub, events } = hubOn(dir, { entry: 'invoice.html' });
  assert.equal(hub.watched(), 3, 'the folder and two levels of asset folders, not the deep tree');
  fs.writeFileSync(path.join(dir, 'other.html'), '<p>o2</p>');
  fs.writeFileSync(path.join(dir, 'page.css'), 'b{}');
  assert.ok(await until(() => events().some((e) => e.type === 'css')));
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<p>i2</p>');
  assert.ok(await until(() => events().some((e) => e.type === 'reload' && e.data === 'invoice.html')));
  assert.ok(!events().some((e) => e.data === 'other.html'), JSON.stringify(events()));
  hub.close();
});

test('single-file dev serves the page and its assets but not the rest of the folder', async () => {
  const dir = tmp('scope');
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<link rel="stylesheet" href="page.css"><p>i</p>');
  fs.writeFileSync(path.join(dir, 'page.css'), 'a{}');
  fs.writeFileSync(path.join(dir, 'other.html'), '<p>private</p>');
  fs.writeFileSync(path.join(dir, 'bank.json'), '{}');
  fs.writeFileSync(path.join(dir, 'statement.pdf'), '%PDF');
  const prev = process.cwd();
  const { server, port } = await startDev(path.join(dir, 'invoice.html'), { port: 4760 });
  try {
    const st = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).status;
    assert.equal(await st('/invoice.html'), 200);
    assert.equal(await st('/page.css'), 200);
    assert.equal(await st('/other.html'), 404);
    assert.equal(await st('/bank.json'), 404);
    assert.equal(await st('/statement.pdf'), 404);
  } finally {
    server.close();
    process.chdir(prev);
  }
});

test('a root-level content file does not turn every .json in the site into content', async () => {
  const { classify } = await import('../packages/server-node/live.js');
  assert.equal(classify('site.json', 'site.json'), 'content');
  assert.equal(classify('alt.json', 'site.json'), 'content');
  assert.equal(classify(path.join('versions', 'launch', 'site.json'), 'site.json'), 'content');
  assert.equal(classify(path.join('data', 'prices.json'), 'site.json'), 'reload');
});

test('static files: dev revalidates every load, serve keeps its own caching', async () => {
  const dir = site();
  const head = async (opts) => {
    let headers = null;
    const res = { writeHead: (_s, h) => { headers = h; }, end() {} };
    assert.ok(await serveStatic({}, res, '/styles.css', { webRoot: dir, ...opts }));
    return headers;
  };
  assert.equal((await head({}))['cache-control'], undefined, 'serve passes nothing, so no header is added');
  assert.equal((await head({ cacheControl: 'no-cache' }))['cache-control'], 'no-cache');
});

test('a client whose socket died is dropped, and the others still get the event', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  let dead = false;           // connects fine, then its socket goes away
  hub.handle({ on() {} }, { writeHead() {}, write() { if (dead) throw new Error('EPIPE'); }, end() {}, destroy() {} });
  dead = true;
  assert.equal(hub.clients(), 2);
  assert.doesNotThrow(() => hub.emit('content', 'content/site.json'));
  assert.equal(hub.clients(), 1, 'the dead client is gone');
  assert.ok(events().some((e) => e.type === 'content'), 'the live client still got it');
  hub.close();
});

test('single-file mode streams the images and fonts it serves', async () => {
  const dir = tmp('single-img');
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<img src="logo.png">');
  fs.writeFileSync(path.join(dir, 'logo.png'), 'a');
  const { hub, events } = hubOn(dir, { entry: 'invoice.html' });
  fs.writeFileSync(path.join(dir, 'logo.png'), 'b');
  assert.ok(await until(() => events().some((e) => e.type === 'reload' && e.data === 'logo.png')), JSON.stringify(events()));
  hub.close();
});

test('a folder swapped in whole announces what is nested in it, and a script outranks a stylesheet', async () => {
  const dir = site();
  fs.mkdirSync(path.join(dir, 'assets'));
  const { hub, events } = hubOn(dir);
  await sleep(50);
  const next = tmp('assets-next');
  fs.mkdirSync(path.join(next, 'css'));
  fs.mkdirSync(path.join(next, 'js'));
  fs.writeFileSync(path.join(next, 'css', 'main.css'), 'a{}');
  fs.writeFileSync(path.join(next, 'js', 'app.js'), '1');
  fs.rmSync(path.join(dir, 'assets'), { recursive: true });
  fs.renameSync(next, path.join(dir, 'assets'));
  assert.ok(await until(() => events().some((e) => e.type === 'reload' && e.data === 'assets/js/app.js')), JSON.stringify(events()));
  hub.close();
});

test('single-file mode serves and streams assets in shallow folders, nothing deeper', async () => {
  const dir = tmp('single-nested');
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<link rel="stylesheet" href="css/main.css">');
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'css', 'main.css'), 'a{}');
  const { hub, events } = hubOn(dir, { entry: 'invoice.html' });
  fs.writeFileSync(path.join(dir, 'css', 'main.css'), 'b{}');
  assert.ok(await until(() => events().some((e) => e.type === 'css' && e.data === 'css/main.css')), JSON.stringify(events()));
  hub.close();
  assert.equal(singleFileServes('/css/main.css', 'invoice.html'), true);
  assert.equal(singleFileServes('/a/b/logo.png', 'invoice.html'), true);
  assert.equal(singleFileServes('/a/b/c/logo.png', 'invoice.html'), false);
});

test('a folder whose name looks like a file is still re-armed when it is swapped in', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  await sleep(50);
  const next = tmp('themecss');
  fs.writeFileSync(path.join(next, 'a.css'), 'a{}');
  fs.renameSync(next, path.join(dir, 'theme.css'));
  assert.ok(await until(() => events().some((e) => e.data === 'theme.css/a.css')), JSON.stringify(events()));
  fs.writeFileSync(path.join(dir, 'theme.css', 'a.css'), 'b{}');
  assert.ok(await until(() => events().filter((e) => e.data === 'theme.css/a.css').length >= 2), 'later writes inside it stream too');
  hub.close();
});

test('plater serve mounts the content-only stream', async () => {
  const dir = site();
  const prev = process.cwd();
  const { server, port } = await startServe(dir, { port: 4790 });
  try {
    const ctrl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/api/live`, { signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    ctrl.abort();
  } finally {
    server.close();
    process.chdir(prev);
  }
});

test('single-file mode sends / to the page, never to a sibling index.html', async () => {
  const dir = tmp('scope-index');
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<p>i</p>');
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>someone else</p>');
  const prev = process.cwd();
  const { server, port } = await startDev(path.join(dir, 'invoice.html'), { port: 4770 });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/invoice.html');
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 404);
  } finally {
    server.close();
    process.chdir(prev);
  }
});

test('plater serve watches only the content folder', () => {
  const dir = site();
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(dir, `assets${i}`));
  const { hub } = hubOn(dir, { contentOnly: true });
  assert.equal(hub.watched(), 1, 'just content/, so asset folders cannot use up the cap');
  hub.close();
});

test('a folder too big to read in full still announces, conservatively', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  await sleep(50);
  const big = tmp('big');
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(big, `n${i}.txt`), '');
  fs.renameSync(big, path.join(dir, 'big'));
  assert.ok(await until(() => events().some((e) => e.type === 'reload' && e.data === 'big')), JSON.stringify(events()));
  hub.close();
});

test('a watched folder moved out of the site still announces', async () => {
  const dir = site();
  fs.mkdirSync(path.join(dir, 'theme'));
  fs.writeFileSync(path.join(dir, 'theme', 'main.css'), 'a{}');
  const { hub, events } = hubOn(dir);
  await sleep(50);
  fs.renameSync(path.join(dir, 'theme'), path.join(tmp('gone'), 'theme'));
  assert.ok(await until(() => events().some((e) => e.type === 'reload' && e.data === 'theme')), JSON.stringify(events()));
  hub.close();
});

test('a content folder swapped for an empty one pulls content', async () => {
  const dir = site();
  const { hub, events } = hubOn(dir);
  await sleep(50);
  const empty = tmp('empty');
  fs.renameSync(path.join(dir, 'content'), path.join(tmp('old'), 'content'));
  fs.renameSync(empty, path.join(dir, 'content'));
  assert.ok(await until(() => events().some((e) => e.type === 'content')), JSON.stringify(events()));
  hub.close();
});

test('single-file mode serves no site APIs, and the stream takes GET only', async () => {
  const dir = tmp('scope-api');
  fs.writeFileSync(path.join(dir, 'invoice.html'), '<p>i</p>');
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'content', 'site.json'), '{"secret":1}');
  const prev = process.cwd();
  const { server, port } = await startDev(path.join(dir, 'invoice.html'), { port: 4775 });
  try {
    for (const p of ['/api/content', '/api/config', '/api/versions']) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 404, p);
    }
    const post = await fetch(`http://127.0.0.1:${port}/api/live`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  } finally {
    server.close();
    process.chdir(prev);
  }
});
