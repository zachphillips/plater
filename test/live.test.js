// Live reload: plater dev streams disk changes on /api/live and injects a
// client into every HTML page, so an open tab follows an agent's turn or
// another editor's save without a refresh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDev } from '../cli/dev.mjs';
import { classify, injectLiveClient, LIVE_CLIENT } from '../packages/server-node/live.js';

const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-live-'));
fs.mkdirSync(path.join(siteDir, 'content'));
fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><link rel="stylesheet" href="styles.css"><body><h1 data-bind="title">Hi</h1></body>\n');
fs.writeFileSync(path.join(siteDir, 'styles.css'), 'h1{color:red}\n');
fs.writeFileSync(path.join(siteDir, 'content', 'site.json'), '{"title":"Hi"}\n');

const prevCwd = process.cwd();
const { server, port } = await startDev(siteDir, { port: 4700 });
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); process.chdir(prevCwd); });

// Read SSE frames off /api/live until `want` events of the given types arrive.
async function collect(types, act, { timeout = 4000 } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/live`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const seen = [];
  let buf = '';
  const timer = setTimeout(() => ctrl.abort(), timeout);
  // Give fs.watch a beat to arm before the write we are waiting on.
  setTimeout(act, 150);
  try {
    while (!types.every((t) => seen.some((e) => e.type === t))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (type) seen.push({ type, data });
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return seen;
}

test('an agent writing site.json on disk streams a content event', async () => {
  const seen = await collect(['content'], () =>
    fs.writeFileSync(path.join(siteDir, 'content', 'site.json'), '{"title":"Changed by an agent"}\n'));
  assert.deepEqual(seen.find((e) => e.type === 'content'), { type: 'content', data: 'content/site.json' });
});

test('a save through /api/save streams a content event to other tabs', async () => {
  const seen = await collect(['content'], () => fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: { title: 'Saved in another tab' } }),
  }));
  assert.ok(seen.some((e) => e.type === 'content'));
});

test('a stylesheet edit streams css, not a reload', async () => {
  const seen = await collect(['css'], () => fs.writeFileSync(path.join(siteDir, 'styles.css'), 'h1{color:blue}\n'));
  assert.deepEqual(seen.find((e) => e.type === 'css'), { type: 'css', data: 'styles.css' });
  assert.ok(!seen.some((e) => e.type === 'reload'));
});

test('an HTML edit streams reload', async () => {
  const seen = await collect(['reload'], () => fs.appendFileSync(path.join(siteDir, 'index.html'), '<!-- edited -->\n'));
  assert.ok(seen.some((e) => e.type === 'reload' && e.data === 'index.html'));
});

test('served HTML carries the live client, once, before </body>', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.equal(html.split('/__plater/live.js').length - 1, 1);
  assert.ok(html.indexOf('/__plater/live.js') < html.lastIndexOf('</body>'));
  const js = await fetch(`${base}/__plater/live.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(await js.text(), LIVE_CLIENT);
  assert.equal(injectLiveClient(injectLiveClient('<body></body>')), injectLiveClient('<body></body>'));
});

test('dotfiles, git internals and node_modules never stream', () => {
  assert.equal(classify('.git/index', 'content/site.json'), null);
  assert.equal(classify('.plater-review.json', 'content/site.json'), null);
  assert.equal(classify('node_modules/x/index.js', 'content/site.json'), null);
  assert.equal(classify('content/versions/draft/site.json', 'content/site.json'), 'content');
  assert.equal(classify('content-edits.json', 'content/site.json'), 'reload');
  assert.equal(classify('notes.md', 'content/site.json'), null);
});

test('the editor ships live reload and the client parses', () => {
  const editor = fs.readFileSync(new URL('../packages/core/src/editor.js', import.meta.url), 'utf8');
  for (const needle of ["new EventSource(`${apiBase}/live`)", 'function pullRemote', 'sansStamp', 'SAVE_INFLIGHT']) {
    assert.ok(editor.includes(needle), `editor.js is missing ${needle}`);
  }
  assert.doesNotThrow(() => new Function(LIVE_CLIENT));
});

test('every asset type a page loads reloads it, fonts and icons included', () => {
  for (const f of ['favicon.ico', 'fonts/a.woff', 'fonts/a.ttf', 'fonts/a.otf', 'fonts/a.woff2', 'img/a.png']) {
    assert.equal(classify(f, 'content/site.json'), 'reload', f);
  }
});

// Run the injected client in a small fake browser.
function runClient(core, { v = null } = {}) {
  const sources = [];
  let reloaded = false;
  class ES { constructor(u) { this.u = u; this.on = {}; sources.push(this); } addEventListener(t, f) { (this.on[t] ||= []).push(f); } fire(t, data, id = '') { for (const f of this.on[t] || []) f({ data, lastEventId: id }); } close() { this.closed = true; } }
  const window = { __platerCoreLive: core };
  const ctx = { window, EventSource: ES, navigator: {}, URLSearchParams, URL,
    location: { search: '', href: 'http://127.0.0.1:4188/', origin: 'http://127.0.0.1:4188', reload() { reloaded = true; } },
    document: { currentScript: { src: '/__plater/live.js' + (v ? `?v=${v}` : '') }, querySelectorAll: () => [], createElement: () => ({ style: {} }), body: { appendChild() {} } } };
  new Function(...Object.keys(ctx), LIVE_CLIENT)(...Object.values(ctx));
  return { sources, reloaded: () => reloaded };
}

test('the injected client stays off when the editor said live: false', () => {
  const c = runClient({ off: true, pull() {}, dirty: () => false });
  assert.equal(c.sources.length, 0);
});

test('the injected client skips the reload for a change this tab made, not for others', () => {
  const c = runClient({ off: false, pull() {}, dirty: () => false, mine: (p) => p === 'images/up.png' });
  c.sources[0].fire('reload', 'images/up.png');
  assert.equal(c.reloaded(), false);
  c.sources[0].fire('reload', 'images/other.png');
  assert.equal(c.reloaded(), true);
});

test('a page with no generation stamp catches up when its stream reconnects', () => {
  const c = runClient(undefined);
  c.sources[0].fire('hello', 'b.0');
  assert.equal(c.reloaded(), false, 'the first connect is just the connection');
  c.sources[0].fire('hello', 'b.0');
  assert.equal(c.reloaded(), true, 'a reconnect reloads, since what changed meanwhile sent no event');
});

test('a standalone page catches a change that landed before its stream opened', () => {
  const c = runClient(undefined, { v: 'b.0' });
  c.sources[0].fire('hello', 'b.1');
  assert.equal(c.reloaded(), true);
});

test('the editor pulls only when it missed something, on connect and on reconnect', () => {
  let pulls = 0;
  const c = runClient({ off: false, pull() { pulls++; }, dirty: () => false }, { v: 'b.0' });
  c.sources[0].fire('hello', 'b.0');
  assert.equal(pulls, 0, 'nothing missed between load and connect');
  c.sources[0].fire('content', 'content/site.json', 'b.1');
  assert.equal(pulls, 1, 'the live event');
  c.sources[0].fire('hello', 'b.1');
  assert.equal(pulls, 1, 'a reconnect that missed nothing');
  c.sources[0].fire('hello', 'c.0');
  assert.equal(pulls, 2, 'a server restart counts as a change');
  assert.equal(c.reloaded(), false);
});

test('the injected tag carries the generation the page was served at', () => {
  const html = injectLiveClient('<body></body>', 'b.3');
  assert.ok(html.includes('/__plater/live.js?v=b.3'));
  assert.equal(injectLiveClient(html, 'b.4'), html, 'never injected twice');
});
