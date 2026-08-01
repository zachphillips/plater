// The out-of-the-box origin. Neither CMS_SITE_URL nor site.json meta.url is set
// on a fresh site, and both used to be fatal: /sitemap.xml 500'd on a link the
// `plater dev` banner had just printed, and /feed.xml served <link></link> —
// an RSS 2.0 required element, so the feed failed every validator. The request's
// own host is the fallback. Configuration must still win over it, because the
// Host header is caller-controlled and CMS_SITE_URL is not.
import test from 'node:test';
import assert from 'node:assert/strict';

// Both handlers snapshot env at import time, so each case imports a fresh copy
// (cache-busting query) with env already set the way that case needs it.
let n = 0;
async function load(name, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await import(`../packages/server-node/${name}?origin-test=${++n}`);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

// Minimal stand-in for the Vercel-shaped res the handlers write to.
function fakeRes() {
  const r = { code: 200, body: '', headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (o) => { r.body = JSON.stringify(o); return r; };
  return r;
}

const CONTENT = { meta: { title: 'Test Site' }, feed: { items: [{ id: '/one/', title: 'One' }] } };

test('rss/json feed fall back to the request origin only when nothing is configured', async () => {
  const { rssXml, jsonFeed } = await load('feed.js', { CMS_SITE_URL: undefined });
  const { body } = rssXml(CONTENT, '', 'http://127.0.0.1:4188');
  assert.match(body, /<link>http:\/\/127\.0\.0\.1:4188<\/link>/);
  // RSS 2.0 requires a non-empty description; with none written, the title stands in.
  assert.match(body, /<description>Test Site<\/description>/);
  assert.equal(JSON.parse(jsonFeed(CONTENT, '', 'http://127.0.0.1:4188').body).home_page_url, 'http://127.0.0.1:4188');

  // meta.url is configuration and outranks the fallback.
  const configured = { ...CONTENT, meta: { ...CONTENT.meta, url: 'https://real.example' } };
  assert.match(rssXml(configured, '', 'http://evil.example').body, /<link>https:\/\/real\.example<\/link>/);
});

test('feed ITEM ids never move with the request host — an id is stable forever', async () => {
  const { jsonFeed } = await load('feed.js', { CMS_SITE_URL: undefined });
  // Relative item ids stay relative rather than absolutizing against whichever
  // hostname asked; otherwise every reader re-delivers the item per host.
  const a = JSON.parse(jsonFeed(CONTENT, '', 'https://one.example').body).items[0].id;
  const b = JSON.parse(jsonFeed(CONTENT, '', 'https://two.example').body).items[0].id;
  assert.equal(a, b);
});

test('sitemap serves 200 against the request host with no CMS_SITE_URL, and prefers config', async () => {
  const env = { CMS_SITE_URL: undefined, GITHUB_EDIT_PATH: 'examples/static-site/content/site.json', PLATER_WEB_ROOT: 'examples/static-site' };
  const sitemap = await load('sitemap.js', env);
  const res = fakeRes();
  await sitemap.default({ method: 'GET', headers: { host: '127.0.0.1:4188' } }, res);
  assert.equal(res.code, 200);
  assert.match(res.body, /<loc>http:\/\/127\.0\.0\.1:4188\/<\/loc>/);

  const configured = await load('sitemap.js', { ...env, CMS_SITE_URL: 'https://real.example' });
  const res2 = fakeRes();
  await configured.default({ method: 'GET', headers: { host: 'evil.example' } }, res2);
  assert.equal(res2.code, 200);
  assert.ok(!res2.body.includes('evil.example'));
  assert.match(res2.body, /<loc>https:\/\/real\.example\/<\/loc>/);
});

test('sitemap refuses a Host that is not a plain host[:port] rather than trusting it', async () => {
  const sitemap = await load('sitemap.js', { CMS_SITE_URL: undefined, GITHUB_EDIT_PATH: 'examples/static-site/content/site.json', PLATER_WEB_ROOT: 'examples/static-site' });
  for (const host of ['https://evil.com', 'example.com/../etc', 'a b', '']) {
    const res = fakeRes();
    await sitemap.default({ method: 'GET', headers: { host } }, res);
    assert.equal(res.code, 500, `host ${JSON.stringify(host)} should not become a base`);
    assert.match(res.body, /needs CMS_SITE_URL or meta\.url/);
  }
});

test('proxy headers decide the scheme; a bare hostname is assumed public https', async () => {
  const sitemap = await load('sitemap.js', { CMS_SITE_URL: undefined, GITHUB_EDIT_PATH: 'examples/static-site/content/site.json', PLATER_WEB_ROOT: 'examples/static-site' });
  const call = async (headers) => { const res = fakeRes(); await sitemap.default({ method: 'GET', headers }, res); return res.body; };
  assert.match(await call({ host: 'example.com' }), /<loc>https:\/\/example\.com\//);
  assert.match(await call({ host: '127.0.0.1:4188', 'x-forwarded-proto': 'https' }), /<loc>https:\/\/127\.0\.0\.1:4188\//);
  assert.match(await call({ host: 'origin.internal', 'x-forwarded-host': 'cdn.example.com' }), /<loc>https:\/\/cdn\.example\.com\//);
});
