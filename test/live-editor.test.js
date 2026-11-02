// The editor's side of live reload, run in an isolated browser boundary like
// editor-auth.test.js: a content event re-renders without a refresh, a
// tab's unsaved field survives someone else's change, and a host with no
// /api/live stream falls back to polling /api/content.
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

function page({ search = '?edit', stream = true, devNoauth = true } = {}) {
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
  class FakeEventSource {
    constructor(url) { this.url = url; this.on = {}; sources.push(this); queueMicrotask(() => (stream ? this.fire('open') : this.fire('error'))); }
    addEventListener(t, fn) { (this.on[t] ||= []).push(fn); }
    fire(t, data) { for (const fn of this.on[t] || []) fn({ data }); }
    close() { this.closed = true; }
  }
  const window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, confirm: () => true, innerHeight: 800, getSelection: () => null };
  const ctx = vm.createContext({
    window, URLSearchParams, URL, atob, Response, queueMicrotask, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    document: {
      readyState: 'complete', body: node(), head: node(), visibilityState: 'visible', activeElement: null,
      querySelector: (s) => (s.startsWith('#') ? els.get(s.slice(1)) || null : null),
      querySelectorAll: (s) => (s === '[data-bind]' || s === '[data-path]' ? bound : []),
      getElementById: (id) => els.get(id) || null, createElement: () => node(), addEventListener() {}, dispatchEvent() {},
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search, pathname: '/', hostname: 'invoices.example.test', href: 'https://invoices.example.test/' + search, reload() { ctx.reloaded = true; } },
    setTimeout, clearTimeout, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    EventSource: FakeEventSource,
    console: { warn() {}, error() {} },
    fetch: async (url, opts = {}) => {
      if (url.endsWith('/config')) return json({ editable: true, devNoauth });
      if (url.includes('/content')) return json(JSON.stringify(server));
      if (url.includes('/versions') || url.includes('/review')) return json({}, 404);
      if (url.endsWith('/save')) { server = { ...JSON.parse(opts.body).content }; return json({ ok: true }); }
      throw new Error('unexpected ' + url);
    },
  });
  vm.runInContext(source, ctx);
  const editor = ctx.initPlater({ tokenKey: 'live.test' });
  return {
    editor, ctx, title, total, sources, intervals,
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

test('a host with no stream (Vercel) falls back to polling /api/content', async () => {
  const p = page({ stream: false });
  await p.boot();
  assert.ok(p.sources[0].closed, 'the dead stream is closed');
  assert.equal(p.intervals.length, 1);
  assert.equal(p.intervals[0].ms, 4000);
  p.server = { title: 'Polled', total: '$1' };
  await p.intervals[0].fn();
  await drain();
  assert.equal(p.title.textContent, 'Polled');
});

test('public visitors on a deployed site open no stream and no poll', async () => {
  const p = page({ search: '', devNoauth: false });
  await p.boot();
  assert.equal(p.sources.length, 0);
  assert.equal(p.intervals.length, 0);
});

test('an HTML change reloads a clean page', async () => {
  const p = page();
  await p.boot();
  p.sources[0].fire('reload', 'index.html');
  assert.ok(p.ctx.reloaded, 'clean page reloads on an HTML change');
});
