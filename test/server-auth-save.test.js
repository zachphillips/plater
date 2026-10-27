import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const env = {
  CMS_EDIT_TOKEN: 'unit-edit-token', CMS_ADMIN_EMAIL: 'admin@example.test',
  GOOGLE_CLIENT_ID: 'unit-client', GITHUB_REPOSITORY: 'example/site',
  GITHUB_BRANCH: 'main', GITHUB_EDIT_PATH: 'web/content/site.json',
  GITHUB_TOKEN: 'unit-github-token', CMS_SITE_NAME: 'unit-site',
  CMS_DEPLOY_HOOK: 'https://deploy.example.test/hook',
  PLATER_AGENT_ENDPOINT: 'https://agent.example.test', PLATER_AGENT_TOKEN: 'unit-agent-token',
};
let serial = 0;
async function handler(t, name, overrides = {}) {
  for (const [key, value] of Object.entries({ ...env, ...overrides })) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return (await import(`../packages/server-node/${name}.js?test=${serial++}`)).default;
}
const request = (body) => ({ method: 'POST', headers: { authorization: 'Bearer unit-edit-token' }, body });
function response() {
  return {
    code: 200, body: null, headers: {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key] = value; },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('config advertises Google only with an admin and client; token fallback stays independent', async (t) => {
  for (const [client, admin, token, editable] of [
    ['client', '', '', false], ['', 'admin@example.test', '', false],
    ['client', 'admin@example.test', '', true], ['client', '', 'token', true],
  ]) {
    const config = await handler(t, 'config', { GOOGLE_CLIENT_ID: client, CMS_ADMIN_EMAIL: admin, CMS_EDIT_TOKEN: token });
    const res = response();
    config({ method: 'GET' }, res);
    assert.equal(res.body.editable, editable);
    assert.equal(res.body.googleClientId, client && admin ? client : '');
    assert.equal(res.body.tokenAuth, Boolean(token));
    assert.ok(!Object.values(res.body).includes('token'));
  }
});

test('invalid track names never fall through to a live write', async (t) => {
  const save = await handler(t, 'save');
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not write'); });
  for (const track of ['../live', ' ', 'x/y', 'x?ref=main', 'a'.repeat(65), 0, 42, {}, []]) {
    const res = response();
    await save(request({ content: { title: 'draft' }, track }), res);
    assert.equal(res.code, 400, JSON.stringify(track));
    assert.equal(res.body.error, 'Invalid track name');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('malformed and non-object save payloads return 400', async (t) => {
  const save = await handler(t, 'save');
  for (const body of ['{', 'null', 'true', '42', '[]']) {
    const res = response();
    await save(request(body), res);
    assert.equal(res.code, 400, body);
  }
});

test('draft saves target the overlay and skip deploy hooks; live and promotion trigger them', async (t) => {
  const save = await handler(t, 'save');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push({ url: String(url), ...opts });
    if (opts.method === 'PUT') return json({ commit: { sha: 'saved-sha' } });
    if (opts.method === 'POST') return json({});
    return json({}, 404);
  });
  for (const [extra, suffix, deploy] of [
    [{ track: 'draft.v2' }, '/versions/draft.v2/site.json', false],
    [{}, '/content/site.json', true], [{ track: '' }, '/content/site.json', true],
    [{ promote: 'draft.v2' }, '/content/site.json', true],
  ]) {
    calls.length = 0;
    const res = response();
    await save(request({ content: { title: 'new' }, ...extra }), res);
    assert.equal(res.code, 200);
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put.url.endsWith(suffix), put.url);
    const committed = JSON.parse(Buffer.from(JSON.parse(put.body).content, 'base64'));
    assert.equal(committed.title, 'new');
    assert.equal(calls.some((c) => c.url === env.CMS_DEPLOY_HOOK), deploy);
  }
});

test('save rejects a missing bearer before any network call', async (t) => {
  const save = await handler(t, 'save');
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const res = response();
  await save({ method: 'POST', headers: {}, body: { content: {} } }, res);
  assert.equal(res.code, 401);
  assert.equal(fetch.mock.callCount(), 0);
});

test('agent acceptance validates design references and forces the configured site', async (t) => {
  const relay = await handler(t, 'agent-note');
  const fetch = t.mock.method(globalThis, 'fetch', async () => json({ ok: true }, 202));
  for (const invalid of [
    { designJob: '../other', alternative: 1 }, { designJob: '', alternative: 1 },
    { designJob: 'abc123', alternative: 0 }, { designJob: 'abc123', alternative: -1 },
    { designJob: 'abc123', alternative: 1.5 }, { designJob: 'abc123', alternative: '1' },
    { designJob: 'abc123' },
  ]) {
    const res = response();
    await relay(request({ action: 'accept', ...invalid }), res);
    assert.equal(res.code, 400, JSON.stringify(invalid));
  }
  assert.equal(fetch.mock.callCount(), 0);
  const res = response();
  await relay(request({ action: 'accept', site: 'another-site', designJob: 'abc123', alternative: 2 }), res);
  assert.equal(res.code, 202);
  const [url, opts] = fetch.mock.calls[0].arguments;
  assert.equal(url, env.PLATER_AGENT_ENDPOINT + '/accept');
  assert.deepEqual(JSON.parse(opts.body), { site: 'unit-site', designJob: 'abc123', alternative: 2, route: {} });
});

test('upload rejects SVG (including upper-case extensions) before GitHub access', async (t) => {
  const upload = await handler(t, 'upload');
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not upload'); });
  for (const filename of ['logo.svg', 'LOGO.SVG']) {
    const res = response();
    await upload(request({ filename, dataBase64: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') }), res);
    assert.equal(res.code, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('upload skips identical blobs, rejects hash-prefix collisions, and commits new images', async (t) => {
  const upload = await handler(t, 'upload');
  const buf = Buffer.from('image bytes');
  const sha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
  let existing = sha;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (opts.method === 'PUT') return json({ commit: { sha: 'image-commit' } });
    return existing ? json({ sha: existing }) : json({}, 404);
  });
  for (const [fileSha, status, commit] of [[sha, 200, null], ['different-blob', 409, undefined], [null, 200, 'image-commit']]) {
    existing = fileSha; calls.length = 0;
    const res = response();
    await upload(request({ filename: 'photo.png', dataBase64: buf.toString('base64') }), res);
    assert.equal(res.code, status);
    assert.equal(res.body.commit, commit);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, fileSha === null ? 1 : 0);
    if (status === 200) assert.match(res.body.url, /^\/images\/[a-f0-9]{8}-photo\.png$/);
  }
});
