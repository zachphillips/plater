import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the real framework-free editor in an isolated browser boundary. The
// test-only closure bridge reaches operations normally invoked by the UI;
// no production exports or dependencies are added for testing.
const source = fs.readFileSync(new URL('../packages/core/src/editor.js', import.meta.url), 'utf8')
  .replace('export function initZMS', 'function initZMS')
  .replace('export const initPlater = initZMS;', '')
  .replace('export default initZMS;', 'globalThis.initPlater = initZMS;')
  .replace('getContent: () => CONTENT,', `getContent: () => CONTENT,
    test: { boot, ensureAuthFresh, useEditToken, useBearer, clearBearer, initSignIn,
      markReviewed, scheduleDraftAutosave, draftBanner, isDirty },`);
const jwt = (exp, extra = {}) => 'header.' + Buffer.from(JSON.stringify({ exp, ...extra })).toString('base64url') + '.signature';
const NOW = 1_800_000_000_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function browser({ draft = false, storage = new Map(), config = {}, prompt = null, fetch: customFetch } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  const classes = () => {
    const set = new Set();
    return { toggle(k, on) { if (on) set.add(k); else set.delete(k); }, add(k) { set.add(k); }, remove(k) { set.delete(k); }, contains: (k) => set.has(k) };
  };
  const node = (id = '') => ({
    id, hidden: true, textContent: '', dataset: {}, style: {}, children: [], classList: classes(),
    setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(n) { this.children.push(n); if (n.id) elements.set(n.id, n); return n; },
    insertBefore(n) { return this.appendChild(n); },
    append(...ns) { for (const n of ns) if (typeof n === 'object') this.appendChild(n); },
    remove() { elements.delete(this.id); }, closest() { return null; },
    addEventListener(type, fn) { this[type] = fn; }, focus() {},
    getBoundingClientRect() { return { top: 0, bottom: 30 }; },
    set innerHTML(html) {
      for (const [, childId] of html.matchAll(/id="([^"]+)"/g)) elements.set(childId, node(childId));
    },
  });
  for (const id of ['cms-signin', 'cms-edit', 'cms-status', 'cms-bar', 'cms-save', 'cms-cancel']) elements.set(id, node(id));
  const binding = node(); binding.dataset = { bind: 'title', path: 'title' };
  const document = {
    readyState: 'loading', body: node(), head: node(), title: '',
    querySelector: (s) => s.startsWith('#') ? elements.get(s.slice(1)) || null : null,
    querySelectorAll: (s) => s === '[data-bind]' || s === '[data-path]' ? [binding] : [],
    getElementById: (id) => elements.get(id) || null, createElement: () => node(),
    addEventListener(type, fn) { listeners.set(`document:${type}`, fn); },
  };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key),
  };
  const calls = [];
  const prompts = [];
  const cfg = { editable: true, googleClientId: 'client', tokenAuth: true, adminEmail: 'admin@example.test', ...config };
  const window = {
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    prompt(message) { prompts.push(message); return prompt; }, confirm: () => true, innerHeight: 800,
  };
  const ctx = vm.createContext({
    Date: class extends Date { static now() { return NOW; } },
    window, document, localStorage, sessionStorage: localStorage, URLSearchParams, URL, atob,
    location: { search: draft ? '?edit&draft=v2' : '', pathname: '/', href: `https://site.test/${draft ? '?edit&draft=v2' : ''}` },
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    console: { warn() {}, error() {} },
    fetch: async (url, opts = {}) => {
      calls.push({ url, ...opts });
      if (customFetch) { const out = await customFetch(url, opts); if (out) return out; }
      if (url.endsWith('/config')) return json(cfg);
      if (url.includes('/content')) return json({ title: 'initial' });
      if (url.includes('/versions') || url.endsWith('/review')) return json({}, 404);
      if (url.endsWith('/save')) return json({ ok: true, git: { commit: 'saved' } });
      throw new Error('unexpected request: ' + url);
    },
  });
  vm.runInContext(source, ctx);
  const editor = ctx.initPlater({ tokenKey: 'test.token' });
  const api = {
    editor, window, elements, binding, storage, listeners, prompts, calls, localStorage,
    async boot() { await editor.test.boot(); await drain(); },
    async timer(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `expected a ${ms}ms timer`);
      timers.delete(entry[0]); await entry[1].fn(); await drain();
    },
    google(mode = 'skipped', credential = jwt(Math.floor(NOW / 1000) + 3600)) {
      let callback;
      let count = 0;
      window.google = { accounts: { id: {
        initialize(opts) { callback = opts.callback; }, renderButton() {},
        prompt(notify) { count++; if (mode === 'success') callback({ credential }); else if (mode === 'skipped') notify({ isSkippedMoment: () => true }); },
      } } };
      return { credential, count: () => count, signIn: (value = credential) => callback({ credential: value }) };
    },
    unload() { let blocked = false; listeners.get('beforeunload')?.({ preventDefault() { blocked = true; } }); return blocked; },
  };
  return api;
}

test('JWT-shaped edit tokens persist across page/tab instances without Google refresh', async () => {
  const storage = new Map();
  const first = browser({ storage }); await first.boot();
  const expiredJwt = jwt(1);
  first.editor.test.useEditToken(expiredJwt);
  assert.equal(storage.get('test.token.kind'), 'token');
  for (let i = 0; i < 3; i++) {
    const next = browser({ storage }); const gis = next.google(); await next.boot();
    assert.equal(next.editor.getToken(), expiredJwt);
    assert.equal(await next.editor.test.ensureAuthFresh(), true);
    assert.equal(gis.count(), 0);
    assert.equal(next.prompts.length, 0);
  }
});

test('fresh Google credentials persist; unpadded base64url expiration honors the 60s skew', async () => {
  for (const [seconds, valid] of [[61, true], [60, false], [-1, false]]) {
    const token = jwt(Math.floor(NOW / 1000) + seconds, { label: '💫' });
    const storage = new Map([['test.token', token], ['test.token.kind', 'google']]);
    const b = browser({ storage }); b.google(); await b.boot();
    assert.equal(b.editor.getToken(), valid ? token : null);
    assert.equal(await b.editor.test.ensureAuthFresh(), valid);
  }
});

test('invalid Google tokens are discarded instead of treated as non-expiring edit tokens', async () => {
  for (const token of ['invalid', jwt(undefined), jwt('tomorrow')]) {
    const b = browser({ storage: new Map([['test.token', token], ['test.token.kind', 'google']]) });
    b.google(); await b.boot();
    assert.equal(b.editor.getToken(), null);
    assert.equal(b.storage.has('test.token'), false);
  }
});

test('untyped mixed-auth credentials reauthenticate; token-only legacy installs migrate safely', async () => {
  const b = browser({ storage: new Map([['test.token', jwt(1)]]) }); await b.boot();
  assert.equal(b.editor.getToken(), null);
  const legacy = browser({ config: { googleClientId: '' }, storage: new Map([['test.token', jwt(1)]]) });
  await legacy.boot();
  assert.equal(await legacy.editor.test.ensureAuthFresh(), true);
});

test('skipped One Tap offers the configured token fallback even with GIS loaded', async () => {
  const b = browser({ prompt: 'fallback' }); const gis = b.google(); await b.boot();
  b.editor.test.useBearer(jwt(1));
  assert.equal(await b.editor.test.ensureAuthFresh(), true);
  assert.equal(gis.count(), 1);
  assert.equal(b.editor.getToken(), 'fallback');
  assert.equal(b.storage.get('test.token.kind'), 'token');
  assert.equal(b.prompts.length, 1);
});

test('Google refresh timeout restores sign-in controls and offers token fallback', async () => {
  const b = browser({ prompt: 'fallback' }); b.google('pending'); await b.boot();
  b.editor.test.useBearer(jwt(1));
  const auth = b.editor.test.ensureAuthFresh(); await drain(); await b.timer(5000);
  assert.equal(await auth, true);
  assert.equal(b.editor.getToken(), 'fallback');
});

test('async Google callback enters draft editing; refresh requests are deduplicated', async () => {
  const b = browser({ draft: true }); const gis = b.google('pending'); await b.boot();
  const first = b.editor.test.ensureAuthFresh(); const second = b.editor.test.ensureAuthFresh(); await drain();
  assert.equal(gis.count(), 1);
  gis.signIn();
  assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(b.window.google !== undefined, true);
  assert.equal(b.elements.get('cms-edit').hidden, true);
  assert.ok(b.listeners.has('beforeunload'));
  assert.equal(b.storage.get('test.token.kind'), 'google');
});

test('clearBearer restores Google UI without leaving view mode editable', async () => {
  const b = browser(); await b.boot(); b.editor.test.useEditToken('token');
  b.editor.test.clearBearer();
  assert.equal(b.elements.get('cms-signin').hidden, false);
  assert.equal(b.elements.get('cms-edit').hidden, true);
  assert.equal(b.editor.getToken(), null);
  assert.equal(b.storage.has('test.token.kind'), false);
});

test('save and review clear auth for empty/HTML 401 responses while retaining edits', async () => {
  const b = browser({ fetch: (url, opts) => opts.method === 'POST' ? new Response('<html>unauthorized</html>', { status: 401 }) : null });
  await b.boot(); b.editor.test.useEditToken('rejected'); b.editor.setEditable(true);
  b.binding.textContent = 'unsaved writing';
  await b.editor.save();
  assert.equal(b.editor.getToken(), null);
  assert.equal(b.elements.get('cms-signin').hidden, false);
  assert.equal(b.editor.getContent().title, 'unsaved writing');
  assert.equal(b.unload(), true);
  b.editor.test.useEditToken('rejected');
  await assert.rejects(b.editor.test.markReviewed('/', true), /401/);
  assert.equal(b.editor.getToken(), null);
});

test('all save paths and review refresh stale auth before sending requests', async () => {
  for (const action of ['save', 'review', 'autosave', 'promote']) {
    const b = browser({ draft: action === 'autosave' || action === 'promote' });
    const gis = b.google('success'); await b.boot();
    b.editor.test.useBearer(jwt(1));
    b.editor.setEditable(true); b.binding.textContent = 'new writing';
    if (action === 'save') await b.editor.save();
    if (action === 'review') await assert.rejects(b.editor.test.markReviewed('/', true)); // test endpoint returns 404
    if (action === 'autosave') { b.editor.test.scheduleDraftAutosave(); await b.timer(2000); }
    if (action === 'promote') await b.elements.get('plater-golive').onclick();
    const post = b.calls.find((c) => c.method === 'POST');
    assert.ok(post, action);
    assert.equal(post.headers.authorization, 'Bearer ' + gis.credential, action);
  }
});

test('failed authentication prevents save, promotion, autosave and review requests', async () => {
  const b = browser({ draft: true }); b.google(); await b.boot();
  await b.editor.save();
  await assert.rejects(b.editor.test.markReviewed('/', true), /sign in/);
  b.editor.test.scheduleDraftAutosave(); await b.timer(2000);
  await b.elements.get('plater-golive').onclick();
  assert.equal(b.calls.filter((c) => c.method === 'POST').length, 0);
});

test('draft autosave 401 restores sign-in and keeps unload protection armed', async () => {
  const b = browser({ draft: true, fetch: (url, opts) => opts.method === 'POST' ? new Response('', { status: 401 }) : null });
  b.google(); await b.boot(); b.editor.test.useEditToken('token');
  b.binding.textContent = 'unsaved'; b.editor.test.scheduleDraftAutosave(); await b.timer(2000);
  assert.equal(b.editor.getToken(), null);
  assert.equal(b.elements.get('cms-signin').hidden, false);
  assert.equal(b.unload(), true);
});

test('autosave snapshots submitted content; in-flight edits remain dirty and save next', async () => {
  let release;
  let count = 0;
  const b = browser({ draft: true, fetch: (url, opts) => {
    if (opts.method !== 'POST') return null;
    if (++count === 1) return new Promise((resolve) => { release = () => resolve(json({ ok: true })); });
    return json({ ok: true });
  } });
  b.google(); await b.boot(); b.editor.test.useEditToken('token');
  b.binding.textContent = 'first edit'; b.editor.test.scheduleDraftAutosave();
  const saving = b.timer(2000); await drain();
  assert.ok(release);
  b.binding.textContent = 'second edit';
  // Another collector (buffer write, for example) can update CONTENT in flight.
  b.editor.getContent().title = 'second edit';
  release(); await saving;
  assert.equal(b.editor.test.isDirty(), true);
  assert.equal(b.unload(), true);
  assert.equal(JSON.parse(b.calls.find((c) => c.method === 'POST').body).content.title, 'first edit');
  await b.timer(2000);
  assert.equal(b.editor.test.isDirty(), false);
  assert.equal(b.unload(), false);
  assert.equal(JSON.parse(b.calls.filter((c) => c.method === 'POST')[1].body).content.title, 'second edit');
});

test('manual save also keeps in-flight edits dirty and in edit mode', async () => {
  let release;
  const b = browser({ fetch: (url, opts) => opts.method === 'POST'
    ? new Promise((resolve) => { release = () => resolve(json({ ok: true })); }) : null });
  await b.boot(); b.editor.test.useEditToken('token'); b.editor.setEditable(true);
  b.binding.textContent = 'first'; const saving = b.editor.save(); await drain();
  b.binding.textContent = 'second'; b.editor.getContent().title = 'second'; release(); await saving;
  assert.equal(b.editor.test.isDirty(), true);
  assert.equal(b.unload(), true);
  assert.equal(b.elements.get('cms-save').hidden, false);
});

test('restricted localStorage never prevents sign-in or clearing credentials', async () => {
  const b = browser(); await b.boot();
  for (const key of ['getItem', 'setItem', 'removeItem']) b.localStorage[key] = () => { throw new Error('storage denied'); };
  assert.doesNotThrow(() => b.editor.test.useEditToken('token'));
  assert.equal(b.editor.getToken(), 'token');
  assert.doesNotThrow(() => b.editor.test.clearBearer());
  assert.equal(b.editor.getToken(), null);
});
