// The edit assistant's invariant guards (allowed classes: auth, money,
// privacy). A wrong answer here spends the Claude credit for someone who is not
// an editor, overruns the caps, loses a billed call from the record, or sends
// the key or more of the page than the editor selected. None of that would show
// on screen. The browser journey is verify/assist.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStandin } from '../verify/assist-standin.mjs';

const KEY = 'sk-ant-standin-' + 'k'.repeat(24);
const SENTINEL = 'claude-code-key-must-never-be-sent';
let serial = 0;

async function setup(t, overrides = {}) {
  const standin = await startStandin();
  t.after(() => standin.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-assist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'usage.jsonl');
  const env = {
    CMS_EDIT_TOKEN: 'unit-edit-token', CMS_ADMIN_EMAIL: 'admin@example.test', GOOGLE_CLIENT_ID: 'unit-client',
    CMS_SITE_NAME: 'unit-site',
    PLATER_ASSIST_ANTHROPIC_KEY: KEY, PLATER_ASSIST_ANTHROPIC_WORKSPACE: 'wrkspc_standin',
    PLATER_ASSIST_ANTHROPIC_BASE_URL: standin.url, PLATER_ASSIST_USAGE_LOG: log,
    PLATER_ASSIST_MAX_TOKENS: '700', PLATER_ASSIST_DAILY_PER_EDITOR: '3', PLATER_ASSIST_DAILY_PER_SITE: '5',
    ANTHROPIC_API_KEY: SENTINEL,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key];
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const mod = await import(`../packages/server-node/assist.js?test=${serial++}`);
  const config = (await import(`../packages/server-node/config.js?test=${serial++}`)).default;
  const call = async (body, bearer = 'unit-edit-token') => {
    const res = response();
    await mod.default({ method: 'POST', headers: bearer ? { authorization: 'Bearer ' + bearer } : {}, body }, res);
    return res;
  };
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { standin, call, config, lines, log };
}
function response() {
  return {
    code: 200, body: null, headers: {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key] = value; },
  };
}
const ask = { text: 'Edit this page in the browser.', tag: 'h1', path: 'hero.headline', instruction: 'Make this shorter.' };

test('auth: a visitor who is not a signed-in editor gets nothing and no upstream call is made', async (t) => {
  const { standin, call, lines } = await setup(t);
  const google = t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/')) {
      return new Response(JSON.stringify({ email: 'someone-else@example.test', email_verified: 'true', aud: 'unit-client', exp: Math.floor(Date.now() / 1000) + 600 }));
    }
    return google.mock.original(url, init);
  });
  for (const bearer of ['', 'not-the-token', 'unit-edit-token-x','a-google-token-for-another-account']) {
    const res = await call(ask, bearer);
    assert.equal(res.code, 401, `bearer ${JSON.stringify(bearer)}`);
    assert.ok(!('replacement' in (res.body || {})));
  }
  const get = response();
  const { default: handler } = await import(`../packages/server-node/assist.js?test=${serial++}`);
  await handler({ method: 'GET', headers: { authorization: 'Bearer unit-edit-token' } }, get);
  assert.equal(get.code, 405);
  assert.equal(standin.requests.length, 0, 'no call reached the Anthropic stand-in');
  assert.equal(lines().length, 0, 'nothing was logged');
});

test('no key: the feature is absent and the route says it is not configured', async (t) => {
  const { standin, call, config } = await setup(t, { PLATER_ASSIST_ANTHROPIC_KEY: undefined });
  const res = await call(ask);
  assert.equal(res.code, 501);
  assert.equal(res.body.error, 'assistant not configured');
  const cfg = response(); config({ method: 'GET' }, cfg);
  assert.equal(cfg.body.assist, false);
  assert.equal(standin.requests.length, 0);
});

test('privacy: only the selected element and the instruction go upstream; the key never reaches the browser', async (t) => {
  const { standin, call, config } = await setup(t);
  const res = await call({ ...ask, page: 'SECRET-REST-OF-PAGE', content: { other: 'SECRET-CONTENT' } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ['replacement']);
  const cfg = response(); config({ method: 'GET' }, cfg);
  assert.equal(cfg.body.assist, true);
  for (const out of [res, cfg]) {
    const seen = JSON.stringify(out.body) + JSON.stringify(out.headers);
    assert.ok(!seen.includes(KEY) && !seen.includes('wrkspc_standin'), 'key or workspace in a browser response');
  }
  assert.equal(standin.requests.length, 1);
  const [up] = standin.requests;
  assert.equal(up.headers['x-api-key'], KEY, 'the assistant key, never ANTHROPIC_API_KEY');
  assert.ok(!up.raw.includes(SENTINEL) && !JSON.stringify(up.headers).includes(SENTINEL));
  assert.equal(up.headers['anthropic-workspace-id'], 'wrkspc_standin');
  assert.ok(!up.raw.includes('SECRET-'), 'nothing the editor did not select is sent');
  assert.equal(up.body.messages.length, 1);
  const sent = up.body.messages[0].content;
  assert.ok(sent.includes(ask.text) && sent.includes(ask.instruction) && sent.includes('hero.headline'));
});

test('money: max_tokens is capped, daily limits hold, and only billed responses are logged, once each', async (t) => {
  const { standin, call, lines } = await setup(t, { PLATER_ASSIST_DAILY_PER_EDITOR: '3', PLATER_ASSIST_DAILY_PER_SITE: '50' });
  // Errors with no usage block bill nothing: no log line, and the slot comes back.
  for (const mode of ['400', '429', '529']) {
    standin.setMode(mode);
    const res = await call(ask);
    assert.notEqual(res.code, 200, mode);
    assert.ok(!JSON.stringify(res.body).includes('scoped to a workspace'), 'upstream wording is not forwarded');
  }
  assert.equal(lines().length, 0, 'unbilled errors are not logged');
  standin.setMode('ok');
  for (let i = 0; i < 3; i++) assert.equal((await call(ask)).code, 200);
  const before = standin.requests.length;
  const over = await call(ask);
  assert.equal(over.code, 429, 'the per-editor daily limit holds');
  assert.equal(standin.requests.length, before, 'a refused call is never sent upstream');
  for (const r of standin.requests) assert.equal(r.body.max_tokens, 700, 'max_tokens is the configured cap');

  const log = lines();
  assert.equal(log.length, 3, 'exactly one line per billed response');
  for (const line of log) {
    assert.deepEqual(Object.keys(line).sort(), ['editor', 'model', 'site', 'time', 'usage']);
    assert.equal(line.site, 'unit-site');
    assert.equal(line.editor, 'edit-token');
    assert.equal(line.model, 'claude-sonnet-5-5');
    assert.equal(typeof line.usage.input_tokens, 'number');
    assert.equal(typeof line.usage.output_tokens, 'number');
    assert.equal(line.usage.service_tier, 'standard', 'usage block copied verbatim');
  }
  const raw = fs.readFileSync(path.join(path.dirname(process.env.PLATER_ASSIST_USAGE_LOG), 'usage.jsonl'), 'utf8');
  for (const secret of [ask.text, ask.instruction, 'Edita', '@', KEY]) assert.ok(!raw.includes(secret), `log holds ${secret}`);
});

test('money: the per-site daily limit holds across editors and survives a restart', async (t) => {
  const { standin, call, log } = await setup(t, { PLATER_ASSIST_DAILY_PER_EDITOR: '10', PLATER_ASSIST_DAILY_PER_SITE: '2' });
  assert.equal((await call(ask)).code, 200);
  assert.equal((await call(ask)).code, 200);
  assert.equal((await call(ask)).code, 429);
  // A fresh module (a restarted server) reads today's log and keeps the count.
  const fresh = await import(`../packages/server-node/assist.js?test=${serial++}`);
  const res = response();
  await fresh.default({ method: 'POST', headers: { authorization: 'Bearer unit-edit-token' }, body: ask }, res);
  assert.equal(res.code, 429);
  assert.equal(standin.requests.length, 2);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
});
