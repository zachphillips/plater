// node verify/chatgpt-plan.mjs — prove the ChatGPT plan engine end to end
// WITHOUT OpenAI: no real sign-in, no consent, no inference, no plan usage.
//
//   login   The real login() runs its loopback listener against a local
//           fixture identity provider (authorize → callback → code exchange →
//           ID-token signature check → 0600 credentials). The "browser" is this
//           script following the fixture's redirect. It is a fixture IdP, never
//           auth.openai.com, so nothing here can approve a real consent.
//   turn    The real `codex app-server` binary, launched with the documented
//           ChatGPT-plan provider settings, runs one turn through runPlanTurn()
//           against a local fixture Responses endpoint. Checks that Codex sends
//           the plan token as the bearer, uses store:false + stream:true, keeps
//           to the isolated CODEX_HOME, and that a usage-limit failure is
//           reported as plan-limit, not success.
//
// Needs `codex` on PATH (skips the turn check with a notice if absent).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { login } from '../packages/agent-host/chatgpt.mjs';
import { runPlanTurn, planGate, loadRecord, credentialsFile, PLAN_SCOPE } from '../packages/agent-host/chatgpt-plan.mjs';

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${String(detail).slice(0, 800)}` : ''}`);
  if (!ok) failures++;
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const readBody = async (req) => { let s = ''; for await (const c of req) s += c; return s; };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-verify-plan-'));

/* ---------------- login against a fixture IdP ---------------- */
async function verifyLogin() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fx', alg: 'RS256' };
  let issuer = ''; let authorizeQuery = null; let tokenForm = null;
  const idp = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    if (u.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (u.pathname === '/api/accounts/authorize') {
      authorizeQuery = u.searchParams;
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.search = new URLSearchParams({ code: 'fx-code', state: u.searchParams.get('state'), client_id: 'oaiapp_fixture', scope: u.searchParams.get('scope') }).toString();
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (u.pathname === '/api/accounts/oauth/token') {
      tokenForm = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fx' })).toString('base64url');
      const p = Buffer.from(JSON.stringify({ iss: issuer, aud: 'oaiapp_fixture', sub: 'fx-user', email: 'owner@example.test', nonce: authorizeQuery.get('nonce'), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
      const id_token = `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
      return res.end(JSON.stringify({ access_token: 'fx-access', refresh_token: 'fx-refresh', id_token, expires_in: 3600, scope: tokenForm && authorizeQuery.get('scope') }));
    }
    res.writeHead(404); res.end();
  });
  issuer = `http://127.0.0.1:${await listen(idp)}`;
  const dir = path.join(scratch, 'login', 'chatgpt');
  try {
    let printed = '';
    const done = login({ dir, authBase: issuer, timeoutMs: 15_000, print: async (url) => {
      printed = url;
      // the "browser": follow the fixture's redirect back to the loopback callback
      const r = await fetch(url, { redirect: 'manual' });
      await fetch(r.headers.get('location'));
    } });
    const record = await done;
    check(new URL(printed).searchParams.get('client_id') === 'dynamic_agent_client', 'login: first sign-in uses the registration entrypoint');
    check(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(authorizeQuery.get('redirect_uri')), 'login: loopback redirect on 127.0.0.1');
    check(tokenForm.client_id === 'oaiapp_fixture' && tokenForm.code_verifier && tokenForm.resource === 'https://api.openai.com/v1', 'login: code exchange uses the issued client id, PKCE verifier and resource', JSON.stringify(tokenForm));
    check(record.scope.includes(PLAN_SCOPE) && record.email === 'owner@example.test', 'login: plan grant and verified identity saved');
    check((fs.statSync(credentialsFile(dir)).mode & 0o777) === 0o600, 'login: credentials file is 0600');
    check(loadRecord(dir).access_token === 'fx-access', 'login: record readable by the engine');
    check(planGate({ planUsage: true }, { env: {}, dir }).ok === false, 'login alone does not turn the engine on');
  } catch (e) { check(false, 'login against fixture IdP', e.stack || e.message); }
  finally { idp.close(); }
}

/* ---------------- one real codex app-server turn against a fixture API ------ */
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
async function verifyTurn() {
  if (spawnSync('codex', ['--version']).status !== 0) { console.log('skip turn: codex not on PATH'); return; }
  let mode = 'ok'; const seen = [];
  const api = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : '';
    seen.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || '', body });
    if (u.pathname.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [] })); }
    if (!u.pathname.endsWith('/responses')) { res.writeHead(404); return res.end(); }
    const id = `resp_${seen.length}`;
    if (mode === 'limit') {
      return sse(res, [
        { type: 'response.created', response: { id } },
        { type: 'response.failed', response: { id, error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'subscription_sharing_usage_limit_exceeded' } } },
      ]);
    }
    const item = { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'fixture turn done' }] };
    sse(res, [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'fixture turn done' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ]);
  });
  const port = await listen(api);
  const apiBase = `http://127.0.0.1:${port}/v1`;
  const cwd = path.join(scratch, 'site'); fs.mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init', '-q', cwd]);
  const codexHome = path.join(scratch, 'codex-home');
  try {
    const out = await runPlanTurn({ prompt: 'Reply with "fixture turn done". Do not edit files.', cwd, accessToken: 'fx-plan-token',
      codexHome, apiBase, model: 'gpt-fixture', timeoutMs: 90_000 });
    const calls = seen.filter((s) => s.path.endsWith('/responses'));
    check(out.ok && out.status === 'completed', 'turn: real codex app-server completes a turn through runPlanTurn', JSON.stringify(out));
    check(calls.length > 0 && calls.every((c) => c.auth === 'Bearer fx-plan-token'), 'turn: Codex sends the plan token as the bearer', JSON.stringify(calls.map((c) => c.auth)));
    const req0 = calls[0] ? JSON.parse(calls[0].body) : {};
    check(req0.store === false && req0.stream === true, 'turn: Responses request uses store:false and stream:true', JSON.stringify({ store: req0.store, stream: req0.stream }));
    check(!(req0.input || []).some((i) => i.role === 'system'), 'turn: no system-role input items (the plan route rejects them)');
    check(fs.existsSync(codexHome), 'turn: Codex ran with the isolated CODEX_HOME');
    check(/fixture turn done/.test(out.text || ''), 'turn: agent message streamed back', out.text);
    mode = 'limit';
    const lim = await runPlanTurn({ prompt: 'again', cwd, accessToken: 'fx-plan-token', codexHome, apiBase, model: 'gpt-fixture', timeoutMs: 90_000 });
    check(!lim.ok && lim.status === 'plan-limit', 'turn: a plan usage-limit failure is reported as plan-limit, not success', JSON.stringify(lim));
  } catch (e) { check(false, 'codex app-server turn', e.stack || e.message); }
  finally { api.close(); }
}

await verifyLogin();
await verifyTurn();
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nchatgpt plan engine verified (fixtures only; no OpenAI sign-in or plan usage)');
process.exit(failures ? 1 : 0);
