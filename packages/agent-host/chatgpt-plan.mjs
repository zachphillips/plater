// ChatGPT plan engine for the agent host — "Sign in with ChatGPT" plan usage.
//
// WHAT THIS IS. An optional fourth engine, `chatgpt`, that runs a captured note
// through Codex app-server using the HOST OWNER'S OWN ChatGPT plan, authorized
// through OpenAI's open-source "Sign in with ChatGPT" flow. It is the supported
// route documented at
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//   https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
// and nothing else: Plater never reads ~/.codex/auth.json, never reuses a Codex
// or ChatGPT login, and runs Codex with an isolated CODEX_HOME so the owner's
// private Codex credentials cannot be picked up by accident.
//
// OFF BY DEFAULT, THREE LOCKS. A note runs on the plan only when ALL hold:
//   1. PLATER_CHATGPT_PLAN=1 on the agent host (unset = engine refuses);
//   2. the site's sites.json entry says "planUsage": true (server-side opt-in);
//   3. the owner has signed in on THIS machine (`node chatgpt.mjs login`) and
//      the grant includes chatgpt.tokens.use.direct.
// A locked engine fails the job with a reason. It never falls back to another
// engine, because a silent fallback would spend different credentials.
//
// ELIGIBILITY BOUNDARY (OpenAI docs as of 2026-11-07). Plan usage is offered to
// open-source projects and personal projects that run locally. "Paid or
// remotely hosted apps" must request access first
// (https://openai.com/form/sign-in-with-chatgpt-interest/). Registration is per
// user and per install: each sign-in dynamically registers a client
// (client_id=dynamic_agent_client → an issued oaiapp_… id) bound to that user
// and workspace. It is not a Kitchen-wide credential, and nothing here shares
// one person's plan with other people. Usage counts toward the user's ChatGPT /
// Codex limits, and OpenAI says usage rates may differ between an app and
// ChatGPT; there is no published multiplier. Hosted plater.thekitchen.co and
// team-wide use are NOT covered and stay unimplemented until OpenAI grants
// access.
//
// CONSENT. Sign-in is always a person opening the printed URL in their own
// browser and approving it. Nothing here opens a browser, auto-approves, or
// retries consent. The loopback redirect (http://127.0.0.1:<port>/auth/callback)
// means the browser and this process must be on the same machine.
//
// STORAGE. One record (credentials.json) and one host id (host.json) under
// PLATER_CHATGPT_DIR (default ~/.config/plater/chatgpt), dir 0700, files 0600,
// written atomically. Tokens never go in URLs, logs, the journal, or the job
// status the browser polls.
//
// PREVIEW LIMITS this engine lives within: Responses API only, store:false,
// stream:true (Codex app-server handles that); no hosted image generation,
// file search, code interpreter or hosted MCP. Design jobs (image generation)
// therefore never use this engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

export const AUTH_BASE = 'https://auth.openai.com';
export const AUTHORIZE_PATH = '/api/accounts/authorize';
export const TOKEN_PATH = '/api/accounts/oauth/token';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const REGISTRATION_CLIENT = 'dynamic_agent_client';
export const APP_NAME = 'Plater';
export const CALLBACK_PATH = '/auth/callback';
const REFRESH_EARLY_MS = 5 * 60_000;

export function planDir(env = process.env) {
  return env.PLATER_CHATGPT_DIR || path.join(os.homedir(), '.config', 'plater', 'chatgpt');
}

/* ---------------- storage ---------------- */

function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export const credentialsFile = (dir) => path.join(dir, 'credentials.json');
export const hostFile = (dir) => path.join(dir, 'host.json');
export const loadRecord = (dir) => readJson(credentialsFile(dir));
export const saveRecord = (dir, record) => writePrivate(credentialsFile(dir), record);

// The host id names THIS machine to OpenAI. Opaque, stable across restarts and
// re-sign-ins, never derived from the user. Created on first sign-in only.
export function hostId(dir, { create = false } = {}) {
  const existing = readJson(hostFile(dir));
  if (existing && typeof existing.ext_agent_host_id === 'string') return existing.ext_agent_host_id;
  if (!create) return null;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  writePrivate(hostFile(dir), { ext_agent_host_id: id, created_at: new Date().toISOString() });
  return id;
}

export function hasPlanGrant(record) {
  if (!record || !record.client_id || !record.access_token || !record.refresh_token) return false;
  const scopes = String(record.scope || '').split(/[\s+]+/);
  return scopes.includes(PLAN_SCOPE);
}

/* ---------------- the three locks ---------------- */

// Returns { ok:true } or { ok:false, reason }. Pure apart from reading the
// credentials file; never throws.
export function planGate(site, { env = process.env, dir = planDir(env) } = {}) {
  if (env.PLATER_CHATGPT_PLAN !== '1') return { ok: false, reason: 'ChatGPT plan engine is off on this agent host (set PLATER_CHATGPT_PLAN=1)' };
  if (!site || site.planUsage !== true) return { ok: false, reason: 'this site is not opted in to ChatGPT plan usage ("planUsage": true in sites.json)' };
  const record = loadRecord(dir);
  if (!record || !record.access_token) return { ok: false, reason: 'no ChatGPT sign-in on this agent host (run: node packages/agent-host/chatgpt.mjs login)' };
  if (!hasPlanGrant(record)) return { ok: false, reason: 'the ChatGPT sign-in did not grant plan usage; sign in again and allow it' };
  return { ok: true };
}

/* ---------------- OAuth: authorize + callback ---------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
export const randomState = () => b64url(crypto.randomBytes(24));

// First sign-in registers a new client (dynamic_agent_client + agent_name_hint).
// A later sign-in reuses the issued client id, drops the name hint, and sends
// the retained id_token as id_token_hint (which is why this URL must never be
// logged once a record exists).
export function authorizeUrl({ record, hostId: host, redirectUri, state, nonce, challenge, authBase = AUTH_BASE }) {
  if (!host) throw new Error('host id required');
  if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri)) throw new Error('redirect must be http://127.0.0.1:<port>/auth/callback');
  const p = new URLSearchParams();
  const reauth = !!(record && record.client_id);
  p.set('client_id', reauth ? record.client_id : REGISTRATION_CLIENT);
  if (!reauth) p.set('agent_name_hint', APP_NAME);
  p.set('ext_agent_host_id', host);
  if (reauth && record.id_token) p.set('id_token_hint', record.id_token);
  p.set('response_type', 'code');
  p.set('scope', SCOPES);
  p.set('resource', RESOURCE);
  p.set('redirect_uri', redirectUri);
  p.set('state', state);
  p.set('nonce', nonce);
  p.set('code_challenge', challenge);
  p.set('code_challenge_method', 'S256');
  return `${authBase}${AUTHORIZE_PATH}?${p}`;
}

// Validates the loopback callback. Throws on anything that is not a clean,
// matching grant: wrong state, a refusal, a missing code, a client id that
// differs from the one already issued, or a new registration with no id.
export function readCallback(callbackUrl, { state, knownClientId = null }) {
  const u = new URL(callbackUrl, 'http://127.0.0.1');
  const q = u.searchParams;
  const got = q.get('state') || '';
  const sa = Buffer.from(got); const sb = Buffer.from(String(state));
  if (sa.length !== sb.length || !crypto.timingSafeEqual(sa, sb)) throw new Error('state mismatch; sign-in ignored');
  if (q.get('error')) throw new Error(q.get('error') === 'access_denied' ? 'sign-in was declined' : `sign-in failed: ${q.get('error')}`);
  const code = q.get('code');
  if (!code) throw new Error('callback had no authorization code');
  const issued = q.get('client_id');
  let clientId;
  if (knownClientId) {
    if (issued && issued !== knownClientId) throw new Error('callback returned a different client id than this registration');
    clientId = knownClientId;
  } else {
    if (!issued) throw new Error('registration incomplete: callback had no issued client id');
    clientId = issued;
  }
  return { code, clientId, scope: q.get('scope') || '' };
}

async function tokenRequest(fetchImpl, authBase, form) {
  const r = await fetchImpl(`${authBase}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`token endpoint ${r.status}: ${data.error || 'error'}`);
    err.code = data.error; throw err;
  }
  if (!data.access_token) throw new Error('token endpoint returned no access token');
  return data;
}

export function exchangeCode({ fetch: fetchImpl = fetch, authBase = AUTH_BASE, clientId, code, verifier, redirectUri }) {
  return tokenRequest(fetchImpl, authBase, {
    grant_type: 'authorization_code', client_id: clientId, code,
    code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
  });
}

/* ---------------- ID token verification (signature, iss, aud, exp, nonce) --- */

export async function verifyIdToken(idToken, { clientId, nonce, fetch: fetchImpl = fetch, authBase = AUTH_BASE, now = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed id token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error(`unsupported id token alg ${header.alg}`);
  const conf = await (await fetchImpl(`${authBase}/.well-known/openid-configuration`)).json();
  if (!conf.jwks_uri) throw new Error('no jwks_uri in OpenID configuration');
  const jwks = await (await fetchImpl(conf.jwks_uri)).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('id token signed by an unknown key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('id token signature invalid');
  const issuer = conf.issuer || authBase;
  if (claims.iss !== issuer) throw new Error('id token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('id token audience mismatch');
  if (!claims.exp || now / 1000 > Number(claims.exp)) throw new Error('id token expired');
  if (claims.nonce !== nonce) throw new Error('id token nonce mismatch');
  return claims;
}

/* ---------------- record assembly + refresh ---------------- */

export function buildRecord({ prior, clientId, host, tokens, claims, now = Date.now() }) {
  return {
    issuer: claims?.iss || prior?.issuer || AUTH_BASE,
    sub: claims?.sub || prior?.sub || null,
    email: claims?.email || prior?.email || null,
    client_id: clientId,
    ext_agent_host_id: host,
    id_token: tokens.id_token || prior?.id_token || null,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prior?.refresh_token || null,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope || prior?.scope || '',
    expires_at: now + Number(tokens.expires_in || 3600) * 1000,
    saved_at: new Date(now).toISOString(),
  };
}

// Refreshes are serialized per credentials dir: two jobs racing a rotating
// refresh token would invalidate each other.
const inflight = new Map();
export function freshAccessToken({ dir = planDir(), fetch: fetchImpl = fetch, authBase = AUTH_BASE, now = () => Date.now() } = {}) {
  const record = loadRecord(dir);
  if (!hasPlanGrant(record)) return Promise.reject(new Error('no ChatGPT plan grant on this host'));
  if (Number(record.expires_at || 0) - now() > REFRESH_EARLY_MS) return Promise.resolve(record.access_token);
  if (inflight.has(dir)) return inflight.get(dir);
  const p = (async () => {
    const latest = loadRecord(dir) || record;
    if (Number(latest.expires_at || 0) - now() > REFRESH_EARLY_MS) return latest.access_token;
    // omit scope to keep the grant; the issued client id, never the registration entrypoint
    const tokens = await tokenRequest(fetchImpl, authBase, {
      grant_type: 'refresh_token', client_id: latest.client_id,
      refresh_token: latest.refresh_token, resource: RESOURCE,
    });
    const next = buildRecord({ prior: latest, clientId: latest.client_id, host: latest.ext_agent_host_id, tokens, claims: null, now: now() });
    saveRecord(dir, next);
    return next.access_token;
  })().finally(() => inflight.delete(dir));
  inflight.set(dir, p);
  return p;
}

/* ---------------- Codex app-server turn ---------------- */

export function appServerArgs({ apiBase = RESOURCE } = {}) {
  const c = (kv) => ['-c', kv];
  return ['app-server', '--listen', 'stdio://',
    ...c('model_provider="openai_chatgpt_plan"'),
    ...c('model_providers.openai_chatgpt_plan.name="ChatGPT plan"'),
    ...c(`model_providers.openai_chatgpt_plan.base_url="${apiBase}"`),
    ...c('model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"'),
    ...c('model_providers.openai_chatgpt_plan.wire_api="responses"'),
    ...c('model_providers.openai_chatgpt_plan.requires_openai_auth=false'),
    ...c('model_providers.openai_chatgpt_plan.supports_websockets=false'),
  ];
}

// The child gets the plan token as ACCESS_TOKEN and an isolated CODEX_HOME.
// The agent-host bearer and any Codex/OpenAI keys from the parent are dropped.
export function childEnv(parentEnv, { accessToken, codexHome }) {
  const env = { ...parentEnv };
  for (const k of Object.keys(env)) {
    if (/^(PLATER_AGENT_TOKEN|ZMS_AGENT_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CODEX_HOME)$/.test(k)) delete env[k];
  }
  env.ACCESS_TOKEN = accessToken;
  env.CODEX_HOME = codexHome;
  return env;
}

const LIMIT_CODES = ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'];

// Drives one turn over app-server's stdio JSON-RPC. Resolves
// { ok, status, text, detail }. Only turn status "completed" is success.
export function runPlanTurn({ prompt, cwd, accessToken, codexHome, model = process.env.PLATER_CHATGPT_MODEL || null,
  sandbox = process.env.PLATER_CHATGPT_SANDBOX || 'workspace-write', timeoutMs = 8 * 60_000,
  spawn = nodeSpawn, codexBin = 'codex', apiBase = RESOURCE, version = '0.1.0', onChild } = {}) {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return new Promise((resolve) => {
    const child = spawn(codexBin, appServerArgs({ apiBase }), {
      cwd, env: childEnv(process.env, { accessToken, codexHome }), stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (onChild) onChild(child);
    let nextId = 1; let buf = ''; let threadId = null; let text = ''; let stderr = ''; let done = false;
    const pending = new Map();
    const finish = (out) => {
      if (done) return; done = true; clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      resolve({ text, ...out });
    };
    const timer = setTimeout(() => finish({ ok: false, status: 'timeout', detail: 'plan turn timed out' }), timeoutMs);
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++; pending.set(id, { res, rej }); send({ id, method, params });
    });
    const classify = (message) => {
      const m = String(message || '');
      return LIMIT_CODES.some((c) => m.includes(c)) ? 'plan-limit' : 'failed';
    };
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => finish({ ok: false, status: 'failed', detail: `could not start codex app-server: ${e.message}` }));
    child.on('exit', (code) => finish({ ok: false, status: 'failed', detail: `codex app-server exited (${code}) ${stderr.slice(-300)}`.trim() }));
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && msg.method) {
          // A server→client request (approval, user input…). This engine is
          // unattended with approvalPolicy "never"; refuse anything that asks.
          send({ id: msg.id, error: { code: -32601, message: 'Plater runs unattended; no interactive requests' } });
        } else if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id); pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message || 'app-server error')); else p.res(msg.result);
        } else if (msg.method === 'item/agentMessage/delta') {
          text = (text + (msg.params?.delta || '')).slice(-20_000);
        } else if (msg.method === 'turn/completed' && msg.params?.threadId === threadId) {
          const turn = msg.params.turn || {};
          if (turn.status === 'completed') finish({ ok: true, status: 'completed' });
          else finish({ ok: false, status: classify(turn.error?.message + ' ' + JSON.stringify(turn.error?.codexErrorInfo || '')), detail: turn.error?.message || turn.status });
        } else if (msg.method === 'error' && msg.params?.willRetry === false) {
          const m = msg.params?.error?.message;
          finish({ ok: false, status: classify(m + ' ' + JSON.stringify(msg.params?.error?.codexErrorInfo || '')), detail: m || 'app-server error' });
        }
      }
    });
    (async () => {
      await request('initialize', { clientInfo: { name: APP_NAME, title: APP_NAME, version } });
      send({ method: 'initialized' });
      const started = await request('thread/start', { cwd, approvalPolicy: 'never', sandbox, ephemeral: true, ...(model ? { model } : {}) });
      threadId = started?.thread?.id;
      if (!threadId) throw new Error('thread/start returned no thread id');
      await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    })().catch((e) => finish({ ok: false, status: classify(e.message), detail: e.message }));
  });
}
