// Hosted Plater write gate. Invariant guards: who may open or change a project,
// which machine calls are accepted, that a version is never overwritten by a
// note racing an edit, and that only the owner's notes reach the owner's plan.
// The real worker.js runs against real SQL (node:sqlite) and a simulated
// Cloudflare Access key; see packages/hosted/local.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import worker, { accessUser, cleanPath, parseProjectPath, _resetAccessCache } from '../packages/hosted/worker.js';
// The local D1 stand-in needs node:sqlite (Node 22+); on Node 20 these skip.
let local = null; try { local = await import('../packages/hosted/local.mjs'); } catch {}
const { access, hostedEnv, serveWorker } = local || {};
const skip = local ? false : 'needs node:sqlite (Node 22+)';
import { createRunner } from '../packages/hosted/runner.mjs';

const OWNER = 'owner@example.test';
async function bench(t, identity = () => OWNER, extra = {}) {
  _resetAccessCache();
  const acc = access();
  const env = hostedEnv(acc, extra);
  const { server, url } = await serveWorker(worker, env, { identity: (req) => identity(req), acc });
  t.after(() => { server.close(); acc.restore(); });
  return { acc, env, url };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function publish(url, project, files, token = 'publish-test-token') {
  const auth = { authorization: `Bearer ${token}` };
  const manifest = {};
  for (const [p, body] of Object.entries(files)) {
    manifest[p] = sha(body);
    await fetch(`${url}/_hosted/blob/${manifest[p]}`, { method: 'PUT', headers: auth, body });
  }
  const r = await fetch(`${url}/_hosted/publish`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ project, files: manifest }) });
  return { status: r.status, body: await r.json() };
}
const page = (h) => `<!doctype html><html><head><title>T</title></head><body><h1 data-bind="h">${h}</h1></body></html>`;

test('Access: only a valid assertion for an allowed email opens anything', { skip }, async (t) => {
  const { acc, env } = await bench(t);
  const req = (jwt) => new Request('https://x/', { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
  assert.equal(await accessUser(req(acc.sign({ email: OWNER })), env), OWNER);
  assert.equal(await accessUser(req(acc.sign({ email: 'OWNER@example.test' })), env), OWNER, 'email case');
  assert.equal(await accessUser(req(null), env), null, 'no assertion');
  assert.equal(await accessUser(req(acc.sign({ email: 'someone@example.test' })), env), null, 'not on the allowlist');
  assert.equal(await accessUser(req(acc.sign({ email: OWNER, aud: ['other-app'] })), env), null, 'another Access app');
  assert.equal(await accessUser(req(acc.sign({ email: OWNER, iss: 'https://evil.cloudflareaccess.com' })), env), null, 'another team');
  assert.equal(await accessUser(req(acc.sign({ email: OWNER, exp: 1 })), env), null, 'expired');
  const forger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal(await accessUser(req(acc.sign({ email: OWNER }, forger)), env), null, 'forged signature');
  assert.equal(await accessUser(req(acc.sign({ email: OWNER })), { ...env, ACCESS_AUD: '' }), null, 'unconfigured fails closed');
});

test('pages and the editor API refuse anyone Access did not sign in', { skip }, async (t) => {
  let who = OWNER;
  const { url } = await bench(t, () => who);
  assert.equal((await publish(url, 'demo', { 'index.html': page('one') })).status, 200);
  who = null;
  for (const p of ['/', '/demo/', '/demo/v1/', '/demo/review']) assert.equal((await fetch(url + p)).status, 403, p);
  const save = await fetch(`${url}/api/save`, { method: 'POST', headers: { referer: `${url}/demo/`, 'content-type': 'application/json' }, body: '{"content":{}}' });
  assert.equal(save.status, 403);
  who = OWNER;
  assert.equal((await fetch(`${url}/demo/`)).status, 200);
});

test('machine API: wrong tokens, bad paths and hash mismatches are refused', { skip }, async (t) => {
  const { url } = await bench(t);
  assert.equal((await publish(url, 'demo', { 'index.html': page('x') }, 'nope')).status, 401);
  assert.equal((await fetch(`${url}/_hosted/runner/next`, { method: 'POST', headers: { authorization: 'Bearer publish-test-token' } })).status, 404, 'the publish token cannot work the note queue');
  const put = await fetch(`${url}/_hosted/blob/${'0'.repeat(64)}`, { method: 'PUT', headers: { authorization: 'Bearer publish-test-token' }, body: 'not that' });
  assert.equal(put.status, 400, 'content must match its hash');
  for (const bad of ['../x.html', '.env', 'a/../../b', '/etc/passwd', 'a//b']) assert.equal(cleanPath(bad), bad === '/etc/passwd' ? 'etc/passwd' : null, bad);
  for (const p of ['/_hosted/x', '/api/x', '/packages/x', '/Bad/']) assert.equal(parseProjectPath(p), null, p);
  assert.deepEqual(parseProjectPath('/demo/v3/a.css'), { project: 'demo', n: 3, rest: '/a.css', bare: false, bareVersion: false });
  assert.equal((await publish(url, 'Bad Slug', { 'index.html': page('x') })).status, 400);
});

test('versions are kept: an edit makes a new version and v1 still shows what it showed', { skip }, async (t) => {
  const { url } = await bench(t);
  await publish(url, 'demo', { 'index.html': page('one'), 'content/site.json': '{"h":"one"}' });
  const ref = { referer: `${url}/demo/`, 'content-type': 'application/json' };
  const r = await fetch(`${url}/api/save`, { method: 'POST', headers: ref, body: JSON.stringify({ content: { h: 'two' }, base: { h: 'one' } }) });
  assert.equal((await r.json()).version, 2);
  const stale = await fetch(`${url}/api/save`, { method: 'POST', headers: ref, body: JSON.stringify({ content: { h: 'three' }, base: { h: 'one' } }) });
  assert.equal(stale.status, 409, 'a stale base is a conflict, not an overwrite');
  assert.equal((await stale.json()).content.h, 'two');
  const old = await fetch(`${url}/api/content`, { headers: { referer: `${url}/demo/v1/` } });
  assert.equal((await old.json()).h, 'one');
  const roSave = await fetch(`${url}/api/save`, { method: 'POST', headers: { ...ref, referer: `${url}/demo/v1/` }, body: JSON.stringify({ content: { h: 'x' } }) });
  assert.equal(roSave.status, 409, 'an older version is read-only');
});

test('a note never overwrites an edit made while it ran, and only the owner\'s notes run', { skip }, async (t) => {
  const { url } = await bench(t, (req) => (req.headers['x-test-who'] || OWNER), { ALLOWED_EMAILS: 'teammate@example.test' });
  await publish(url, 'demo', { 'index.html': page('one'), 'content/site.json': '{"h":"one"}' });
  const note = (who) => fetch(`${url}/api/agent-note`, { method: 'POST', headers: { referer: `${url}/demo/`, 'content-type': 'application/json', 'x-test-who': who },
    body: JSON.stringify({ note: 'change the headline', capture: { selector: 'h1' } }) }).then((r) => r.json());
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-runner-')); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const runs = [];
  const runner = createRunner({ url, token: 'runner-test-token', owner: OWNER, workRoot: work, log: () => {},
    env: { PLATER_CHATGPT_PLAN: '1', PLATER_CHATGPT_DIR: path.join(work, 'cred') },
    run: async ({ cwd }) => { runs.push(cwd); fs.writeFileSync(path.join(cwd, 'content', 'site.json'), '{"h":"from the note"}'); return { ok: true, status: 'completed' }; } });
  // the plan gate still applies: no sign-in on this machine → refused, nothing run
  const a = await note(OWNER);
  await runner.once();
  const sa = await (await fetch(`${url}/api/agent-note`, { method: 'POST', headers: { referer: `${url}/demo/`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', job: a.id }) })).json();
  assert.equal(sa.status, 'failed'); assert.match(sa.detail, /sign-in/); assert.equal(runs.length, 0);
  // signed in now (a fixture record), but another person's note never runs on the owner's plan
  const { saveRecord } = await import('../packages/agent-host/chatgpt-plan.mjs');
  saveRecord(path.join(work, 'cred'), { client_id: 'oaiapp_x', access_token: 'a', refresh_token: 'r', scope: 'chatgpt.tokens.use.direct', expires_at: Date.now() + 3600_000 });
  const t1 = await note('teammate@example.test');
  await runner.once();
  const st = await (await fetch(`${url}/api/agent-note`, { method: 'POST', headers: { referer: `${url}/demo/`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', job: t1.id }) })).json();
  assert.equal(st.status, 'failed'); assert.match(st.detail, /only the owner/); assert.equal(runs.length, 0, 'a teammate\'s note never reached the plan');
  // the owner's note runs and becomes the next version
  const own = await note(OWNER);
  await runner.once();
  const so = await (await fetch(`${url}/api/agent-note`, { method: 'POST', headers: { referer: `${url}/demo/`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', job: own.id }) })).json();
  assert.equal(so.status, 'done'); assert.match(so.prUrl, /\/demo\/v2\/$/); assert.equal(runs.length, 1);
  // an edit lands while the note runs → the note refuses to overwrite it
  await note(OWNER);
  const racing = createRunner({ url, token: 'runner-test-token', owner: OWNER, workRoot: work, log: () => {}, env: { PLATER_CHATGPT_PLAN: '1', PLATER_CHATGPT_DIR: path.join(work, 'cred') },
    run: async ({ cwd }) => {
      await fetch(`${url}/api/save`, { method: 'POST', headers: { referer: `${url}/demo/`, 'content-type': 'application/json' }, body: JSON.stringify({ content: { h: 'typed meanwhile' } }) });
      fs.writeFileSync(path.join(cwd, 'content', 'site.json'), '{"h":"from the second note"}'); return { ok: true, status: 'completed' };
    } });
  await racing.once();
  const content = await (await fetch(`${url}/api/content`, { headers: { referer: `${url}/demo/` } })).json();
  assert.equal(content.h, 'typed meanwhile', 'the typed edit survives');
  const notes = (await (await fetch(`${url}/demo/review`)).text());
  assert.match(notes, /was edited while the note ran/);
});
