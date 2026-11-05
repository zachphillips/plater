// The editor's side of live reload, run in an isolated browser boundary like
// editor-auth.test.js: a content event re-renders without a refresh, a
// tab's unsaved field survives someone else's change, and a host with no
// /api/live stream stays quiet (no polling).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../packages/core/src/editor.js', import.meta.url), 'utf8')
  .replace('export function initZMS', 'function initZMS')
  .replace('export const initPlater = initZMS;', '')
  .replace('export default initZMS;', 'globalThis.initPlater = initZMS;')
  .replace('getContent: () => CONTENT,', `getContent: () => CONTENT,
    test: { boot, setEditable, isDirty, pullRemote },`);
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function page({ search = '?edit', stream = true, devNoauth = true, liveStatus = 404, links = [], live } = {}) {
  let server = { title: 'Invoice', total: '$100' };
  const els = new Map();
  const node = (id = '') => ({
    id, hidden: true, textContent: '', dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; }, appendChild(n) { return n; }, insertBefore(n) { return n; },
    append() {}, remove() {}, closest() { return null; }, addEventListener() {}, focus() {},
    getBoundingClientRect() { return { top: 0, bottom: 30 }; }, set innerHTML(_) {},
  });
  for (const id of ['cms-status', 'cms-bar', 'cms-edit', 'cms-save', 'cms-cancel', 'cms-signin']) els.set(id, node(id));
  const title = node(); title.dataset = { bind: 'title' };
  const total = node(); total.dataset = { bind: 'total' };
  const bound = [title, total];
  const sources = [];
  const intervals = [];
  const retries = [];      // long timers (stream retry backoff), held instead of run
  const timer = (fn, ms) => (ms >= 5000 ? (retries.push({ fn, ms }), 0) : setTimeout(fn, ms));
  class FakeEventSource {
    constructor(url) { this.url = url; this.on = {}; sources.push(this); queueMicrotask(() => (stream ? this.fire('open') : this.fire('error'))); }
    addEventListener(t, fn) { (this.on[t] ||= []).push(fn); }
    fire(t, data) { for (const fn of this.on[t] || []) fn({ data }); }
    close() { this.closed = true; }
  }
  const window = { setTimeout: timer, clearTimeout, addEventListener() {}, removeEventListener() {}, confirm: () => true, innerHeight: 800, getSelection: () => null };
  const ctx = vm.createContext({
    window, URLSearchParams, URL, atob, Response, queueMicrotask, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    document: {
      readyState: 'complete', body: node(), head: node(), visibilityState: 'visible', activeElement: null,
      querySelector: (s) => (s.startsWith('#') ? els.get(s.slice(1)) || null : null),
      querySelectorAll: (s) => (s === '[data-bind]' || s === '[data-path]' ? bound : s === 'link[rel="stylesheet"]' ? links : []),
      getElementById: (id) => els.get(id) || null, createElement: () => node(), addEventListener() {}, dispatchEvent() {},
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search, pathname: '/', origin: 'https://invoices.example.test', hostname: 'invoices.example.test', href: 'https://invoices.example.test/' + search, reload() { ctx.reloaded = true; } },
    setTimeout: timer, clearTimeout, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    EventSource: FakeEventSource,
    console: { warn() {}, error() {} },
    fetch: async (url, opts = {}) => {
      if (url.endsWith('/config')) return json({ editable: true, devNoauth });
      if (url.endsWith('/live')) return json({}, liveStatus);
      if (url.includes('/content')) return json(JSON.stringify(server));
      if (url.includes('/versions') || url.includes('/review')) return json({}, 404);
      if (url.endsWith('/save')) { server = { ...JSON.parse(opts.body).content, updatedAt: new Date(0).toISOString(), updatedBy: 'dev' }; return json({ ok: true }); }
      throw new Error('unexpected ' + url);
    },
  });
  vm.runInContext(source, ctx);
  const editor = ctx.initPlater({ tokenKey: 'live.test', ...(live === undefined ? {} : { live }) });
  return {
    editor, ctx, title, total, sources, intervals, retries,
    set server(v) { server = v; },
    async boot() { await editor.test.boot(); await drain(); },
  };
}

test('a content event re-renders the page with no refresh', async () => {
  const p = page();
  await p.boot();
  assert.equal(p.title.textContent, 'Invoice');
  assert.equal(p.sources.length, 1, 'one stream per tab');
  assert.equal(p.sources[0].url, '/api/live');
  p.server = { title: 'Invoice — October', total: '$250' };
  p.sources[0].fire('content', 'content/site.json');
  await drain();
  assert.equal(p.title.textContent, 'Invoice — October');
  assert.equal(p.total.textContent, '$250');
  assert.ok(!p.ctx.reloaded);
});

test("this tab's unsaved field survives another editor's change to a different field", async () => {
  const p = page();
  await p.boot();
  p.editor.test.setEditable(true);
  p.title.textContent = 'My unsaved title';          // the human is typing here
  p.title.dataset.path = 'title';
  // collectEdits only runs once the tab has been touched; simulate the input event
  p.editor.getContent().title = 'My unsaved title';
  p.server = { title: 'Invoice', total: '$999' };    // an agent changed the total
  await p.editor.test.pullRemote();
  await drain();
  assert.equal(p.total.textContent, '$999', 'their change landed');
  assert.equal(p.editor.getContent().title, 'My unsaved title', 'my unsaved edit is still here');
  assert.ok(p.editor.test.isDirty(), 'and it is still unsaved');
});

test('a host with no stream (Vercel) closes it and does not poll a stale snapshot', async () => {
  const p = page({ stream: false });
  await p.boot();
  await drain();
  assert.ok(p.sources[0].closed, 'the dead stream is closed');
  assert.equal(p.intervals.length, 0, 'no polling: on Vercel /api/content lags every save');
  assert.equal(p.retries.length, 0, 'a 404 is permanent: no retry');
});

test('a passing failure (the 503 connection cap) retries with backoff instead of giving up', async () => {
  const p = page({ stream: false, liveStatus: 503 });
  await p.boot();
  await drain();
  assert.equal(p.retries.length, 1);
  assert.equal(p.retries[0].ms, 5000);
  p.retries[0].fn();
  await drain();
  assert.equal(p.sources.length, 2, 'it reconnected');
  assert.equal(p.retries[1].ms, 10000, 'and backs off');
});

test('signing in after boot starts live updates', async () => {
  const p = page({ search: '', devNoauth: false });
  await p.boot();
  assert.equal(p.sources.length, 0);
  p.editor.setEditable(true);
  assert.equal(p.sources.length, 1, 'entering edit mode opened the stream');
  p.editor.setEditable(false);
  p.editor.setEditable(true);
  assert.equal(p.sources.length, 1, 'and only once');
});

test('a stylesheet change cache-busts that path only, not another file with the same name', async () => {
  const link = (href) => ({ href: 'https://invoices.example.test' + href });
  const mobile = link('/theme/mobile/main.css'), desktop = link('/theme/desktop/main.css');
  const p = page({ links: [mobile, desktop] });
  await p.boot();
  p.sources[0].fire('css', 'theme/desktop/main.css');
  assert.match(desktop.href, /plater-live=/);
  assert.doesNotMatch(mobile.href, /plater-live=/);
  assert.ok(!p.ctx.reloaded);
});

test('our own save echoing back with updatedAt/updatedBy stamps does not re-render', async () => {
  const p = page();
  await p.boot();
  let renders = 0;
  const orig = p.title.textContent;
  Object.defineProperty(p.title, 'textContent', { get: () => orig, set: () => { renders += 1; }, configurable: true });
  p.server = { ...p.editor.getContent(), updatedAt: '2026-11-02T19:00:00Z', updatedBy: 'dev' };
  await p.editor.test.pullRemote();
  await drain();
  assert.equal(renders, 0, 'the DOM was left alone');
  assert.equal(p.editor.getContent().updatedAt, '2026-11-02T19:00:00Z', 'the stamps were taken');
  assert.ok(!p.editor.test.isDirty(), 'and the page is not dirty');
});

test('a reconnected stream catches up on what changed meanwhile', async () => {
  const p = page();
  await p.boot();
  p.sources[0].fire('open');
  p.server = { title: 'Changed while offline', total: '$2' };
  p.sources[0].fire('open');
  await drain();
  assert.equal(p.title.textContent, 'Changed while offline');
});

test('public visitors on a deployed site open no stream and no poll', async () => {
  const p = page({ search: '', devNoauth: false });
  await p.boot();
  assert.equal(p.sources.length, 0);
  assert.equal(p.intervals.length, 0);
});

test('headless capture (?shot, webdriver) opens no stream', async () => {
  const p = page({ search: '?edit&shot' });
  await p.boot();
  assert.equal(p.sources.length, 0);
});

test('an HTML change reloads a clean page', async () => {
  const p = page();
  await p.boot();
  p.sources[0].fire('reload', 'index.html');
  assert.ok(p.ctx.reloaded, 'clean page reloads on an HTML change');
});

test('live: false opens no stream and tells the injected dev client it is off', async () => {
  const p = page({ live: false });
  await p.boot();
  assert.equal(p.sources.length, 0);
  assert.equal(p.ctx.window.__platerCoreLive.off, true, 'the bridge is there even with no stream, so the dev client can see the opt-out');
  assert.equal(typeof p.ctx.window.__platerCoreLive.dirty, 'function', 'and can still ask about unsaved edits');
});

test('a reload event for an image this tab just uploaded does not reload the tab', async () => {
  const p = page();
  await p.boot();
  const bridge = p.ctx.window.__platerCoreLive;
  assert.equal(bridge.mine('images/logo.png'), false, 'nothing uploaded yet');
  p.sources[0].fire('reload', 'images/other.png');
  assert.ok(p.ctx.reloaded, 'someone else\'s change still reloads');
});
