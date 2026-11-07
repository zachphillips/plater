// ChatGPT plan engine gate. Invariant guards in the same class as the CMS write
// gate: a wrong answer here spends the owner's ChatGPT plan without consent,
// accepts a forged or mismatched sign-in, or leaks a token, and nothing on
// screen would show it. No network: every OpenAI endpoint is a local fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planGate, authorizeUrl, readCallback, verifyIdToken, saveRecord, loadRecord, hostId,
  freshAccessToken, childEnv, credentialsFile, REGISTRATION_CLIENT, PLAN_SCOPE,
} from '../packages/agent-host/chatgpt-plan.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-plan-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return path.join(d, 'chatgpt'); };
const granted = { client_id: 'oaiapp_test', access_token: 'at', refresh_token: 'rt', scope: `openid offline_access resource.invoke ${PLAN_SCOPE}`, expires_at: Date.now() + 3600_000 };
const ON = { PLATER_CHATGPT_PLAN: '1' };

test('plan gate fails closed unless all three locks hold', (t) => {
  const dir = tmp(t);
  const site = { planUsage: true };
  assert.equal(planGate(site, { env: {}, dir }).ok, false, 'engine off by default');
  assert.equal(planGate(site, { env: { PLATER_CHATGPT_PLAN: 'true' }, dir }).ok, false, 'only the exact value 1 turns it on');
  assert.equal(planGate({}, { env: ON, dir }).ok, false, 'site must opt in');
  assert.equal(planGate({ planUsage: 'yes' }, { env: ON, dir }).ok, false, 'opt-in must be boolean true');
  assert.equal(planGate(site, { env: ON, dir }).ok, false, 'no sign-in');
  saveRecord(dir, { ...granted, scope: 'openid profile email offline_access' });
  assert.equal(planGate(site, { env: ON, dir }).ok, false, 'identity-only grant does not authorize plan usage');
  saveRecord(dir, granted);
  assert.deepEqual(planGate(site, { env: ON, dir }), { ok: true });
});

test('authorize URL: first sign-in registers, re-sign-in reuses the issued client', () => {
  const base = { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', redirectUri: 'http://127.0.0.1:5123/auth/callback', state: 's', nonce: 'n', challenge: 'c' };
  const first = new URL(authorizeUrl({ ...base, record: null }));
  assert.equal(first.origin + first.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(first.searchParams.get('client_id'), REGISTRATION_CLIENT);
  assert.equal(first.searchParams.get('agent_name_hint'), 'Plater');
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(first.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.ok(first.searchParams.get('scope').split(' ').includes(PLAN_SCOPE));
  assert.equal(first.searchParams.get('ext_agent_host_id'), base.hostId);
  const again = new URL(authorizeUrl({ ...base, record: { client_id: 'oaiapp_x', id_token: 'idt', access_token: 'SECRET-AT', refresh_token: 'SECRET-RT' } }));
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_x');
  assert.equal(again.searchParams.has('agent_name_hint'), false);
  assert.equal(again.searchParams.get('id_token_hint'), 'idt');
  assert.ok(!again.href.includes('SECRET'), 'access and refresh tokens never go in URLs');
  for (const bad of ['http://localhost:5123/auth/callback', 'http://127.0.0.1:5123/callback', 'https://plater.example/auth/callback']) {
    assert.throws(() => authorizeUrl({ ...base, redirectUri: bad, record: null }), /redirect/);
  }
  assert.throws(() => authorizeUrl({ ...base, hostId: null, record: null }), /host id/);
});

test('callback: only a matching, approved, complete grant is accepted', () => {
  const cb = (q) => `/auth/callback?${new URLSearchParams(q)}`;
  assert.throws(() => readCallback(cb({ state: 'evil', code: 'c', client_id: 'oaiapp_a' }), { state: 'good' }), /state/);
  assert.throws(() => readCallback(cb({ state: 'good', error: 'access_denied' }), { state: 'good' }), /declined/);
  assert.throws(() => readCallback(cb({ state: 'good' }), { state: 'good' }), /no authorization code/);
  assert.throws(() => readCallback(cb({ state: 'good', code: 'c' }), { state: 'good' }), /registration incomplete/);
  assert.throws(() => readCallback(cb({ state: 'good', code: 'c', client_id: 'oaiapp_other' }), { state: 'good', knownClientId: 'oaiapp_a' }), /different client id/);
  assert.deepEqual(readCallback(cb({ state: 'good', code: 'c', client_id: 'oaiapp_a' }), { state: 'good' }).clientId, 'oaiapp_a');
  assert.equal(readCallback(cb({ state: 'good', code: 'c' }), { state: 'good', knownClientId: 'oaiapp_a' }).clientId, 'oaiapp_a');
});

function idp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sign = (claims, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  };
  const fetch = async (url) => ({
    ok: true,
    json: async () => (url.endsWith('/.well-known/openid-configuration')
      ? { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' } : { keys: [jwk] }),
  });
  return { sign, fetch };
}

test('id token: signature, issuer, audience, expiry and nonce are all enforced', async () => {
  const { sign, fetch } = idp();
  const good = { iss: 'https://auth.openai.com', aud: 'oaiapp_a', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n1', sub: 'user-1' };
  const opts = { clientId: 'oaiapp_a', nonce: 'n1', fetch };
  assert.equal((await verifyIdToken(sign(good), opts)).sub, 'user-1');
  await assert.rejects(verifyIdToken(sign({ ...good, aud: 'oaiapp_b' }), opts), /audience/);
  await assert.rejects(verifyIdToken(sign({ ...good, iss: 'https://evil.example' }), opts), /issuer/);
  await assert.rejects(verifyIdToken(sign({ ...good, nonce: 'n2' }), opts), /nonce/);
  await assert.rejects(verifyIdToken(sign({ ...good, exp: 1 }), opts), /expired/);
  const forger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyIdToken(sign(good, forger), opts), /signature/);
});

test('credentials are private files and the host id is stable', (t) => {
  const dir = tmp(t);
  assert.equal(hostId(dir), null, 'reading never creates a host id');
  const id = hostId(dir, { create: true });
  assert.match(id, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(hostId(dir, { create: true }), id);
  saveRecord(dir, granted);
  assert.equal(fs.statSync(credentialsFile(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'atomic write leaves no temp file');
});

test('refresh is serialized, keeps the grant and uses the issued client id', async (t) => {
  const dir = tmp(t);
  saveRecord(dir, { ...granted, expires_at: Date.now() - 1000 });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(Object.fromEntries(new URLSearchParams(init.body)));
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, json: async () => ({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }) };
  };
  const [a, b] = await Promise.all([freshAccessToken({ dir, fetch }), freshAccessToken({ dir, fetch })]);
  assert.equal(a, 'at2'); assert.equal(b, 'at2');
  assert.equal(calls.length, 1, 'two jobs must not race a rotating refresh token');
  assert.equal(calls[0].client_id, 'oaiapp_test');
  assert.equal(calls[0].grant_type, 'refresh_token');
  assert.equal('scope' in calls[0], false);
  const saved = loadRecord(dir);
  assert.equal(saved.refresh_token, 'rt2');
  assert.ok(saved.scope.includes(PLAN_SCOPE), 'refresh keeps the plan grant');
});

test('codex child gets the plan token and an isolated CODEX_HOME, not the host secrets', () => {
  const env = childEnv({ PATH: '/bin', PLATER_AGENT_TOKEN: 'bearer', ZMS_AGENT_TOKEN: 'bearer', OPENAI_API_KEY: 'sk', CODEX_HOME: '/Users/me/.codex' },
    { accessToken: 'at', codexHome: '/tmp/x/codex-home' });
  assert.equal(env.ACCESS_TOKEN, 'at');
  assert.equal(env.CODEX_HOME, '/tmp/x/codex-home');
  for (const k of ['PLATER_AGENT_TOKEN', 'ZMS_AGENT_TOKEN', 'OPENAI_API_KEY']) assert.equal(k in env, false, k);
  assert.equal(env.PATH, '/bin');
});
