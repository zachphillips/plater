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
//   draft   The real `plater dev` on a copy of examples/static-site with
//           PLATER_CHATGPT_PLAN=1 and fixture credentials: /api/config turns
//           agentRouting on, pages carry the ✎ Note overlay, cross-site posts are
//           refused, and in headless Chromium (when Playwright is installed) a
//           note picked on the headline runs a real codex turn in the draft
//           folder and finishes as done. Screenshots: PLATER_EVIDENCE_DIR.
//
// Needs `codex` on PATH (skips the turn check with a notice if absent).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { login } from '../packages/agent-host/chatgpt.mjs';
import { runPlanTurn, planGate, loadRecord, saveRecord, credentialsFile, PLAN_SCOPE } from '../packages/agent-host/chatgpt-plan.mjs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    let printed = ''; let strayStatus = 0;
    const done = login({ dir, authBase: issuer, timeoutMs: 15_000, print: async (url) => {
      printed = url;
      // a stray hit with the wrong state must not end the pending sign-in
      const cb = new URL(new URL(url).searchParams.get('redirect_uri'));
      cb.search = 'code=forged&state=wrong&client_id=oaiapp_forged';
      strayStatus = (await fetch(cb)).status;
      // the "browser": follow the fixture's redirect back to the loopback callback
      const r = await fetch(url, { redirect: 'manual' });
      await fetch(r.headers.get('location'));
    } });
    const record = await done;
    check(strayStatus === 400 && record.client_id === 'oaiapp_fixture', 'login: a callback with the wrong state is refused and the real sign-in still completes');
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
function fixtureApi(seen) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : '';
    seen.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || '', body });
    if (u.pathname.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [] })); }
    if (!u.pathname.endsWith('/responses')) { res.writeHead(404); return res.end(); }
    const id = `resp_${seen.length}`;
    const item = { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'fixture turn done' }] };
    sse(res, [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ]);
  });
}

async function verifyDraft() {
  if (spawnSync('codex', ['--version']).status !== 0) { console.log('skip draft: codex not on PATH'); return; }
  const seen = []; const api = fixtureApi(seen);
  const apiPort = await listen(api);
  const draft = path.join(scratch, 'draft'); fs.cpSync(path.join(ROOT, 'examples', 'static-site'), draft, { recursive: true });
  // A typical agent-built draft loads only the editor, no capture of its own:
  // the overlay under test must be the one plater dev injects.
  const indexFile = path.join(draft, 'index.html');
  const stripped = fs.readFileSync(indexFile, 'utf8').replace(/<script type="module">[\s\S]*?<\/script>/,
    `<script type="module">import { initPlater } from '/packages/core/src/editor.js'; initPlater({ brand: 'Draft' });</script>`);
  fs.writeFileSync(indexFile, stripped);
  const dir = path.join(scratch, 'draft-cred', 'chatgpt');
  saveRecord(dir, { client_id: 'oaiapp_fixture', access_token: 'fx-draft-token', refresh_token: 'r', scope: `openid ${PLAN_SCOPE}`, expires_at: Date.now() + 3600_000 });
  Object.assign(process.env, { PLATER_CHATGPT_PLAN: '1', PLATER_CHATGPT_DIR: dir, PLATER_CHATGPT_API_BASE: `http://127.0.0.1:${apiPort}/v1`, PLATER_CHATGPT_MODEL: 'gpt-fixture' });
  const { startDev } = await import('../cli/dev.mjs');
  const dev = await startDev(draft, { port: 0 });
  const base = `http://127.0.0.1:${dev.server.address().port}`;
  try {
    const conf = await (await fetch(`${base}/api/config`)).json();
    check(conf.agentRouting === true, 'draft: plater dev reports agent routing on when the owner opted in', JSON.stringify(conf));
    check((await (await fetch(`${base}/`)).text()).includes('/__plater/notes.js'), 'draft: pages carry the ✎ Note overlay');
    check((await fetch(`${base}/__plater/capture.js`)).ok, 'draft: overlay module served from /__plater/');
    const post = (headers) => fetch(`${base}/api/agent-note`, { method: 'POST', headers, body: JSON.stringify({ note: 'x' }) }).then((r) => r.status);
    check(await post({ 'content-type': 'text/plain' }) === 403, 'draft: a cross-site form post is refused');
    check(await post({ 'content-type': 'application/json', origin: 'https://evil.example' }) === 403, 'draft: a cross-site fetch is refused');
    let chromium = null;
    try { ({ chromium } = await import('playwright')); } catch { console.log('skip draft browser journey: Playwright not installed (npm i --no-save playwright@1.64.1)'); }
    if (chromium) {
      const shots = process.env.PLATER_EVIDENCE_DIR || null;
      if (shots) fs.mkdirSync(shots, { recursive: true });
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
        await page.goto(`${base}/?edit`);
        const launch = page.locator('button', { hasText: '✎ Note' });
        await launch.waitFor({ timeout: 10_000 });
        check(await page.locator('#cms-bar button', { hasText: '✎ Note' }).count() === 1, 'draft: ✎ Note sits in the editor bar');
        if (shots) await page.screenshot({ path: path.join(shots, '1-edit-bar.png') });
        await launch.click();
        await page.locator('h1').first().click();
        const ta = page.locator('.zmscap-pop textarea');
        await ta.waitFor({ timeout: 5_000 });
        await ta.fill('Make the headline shorter');
        if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(shots, '2-note.png') }); }
        await page.locator('.zmscap-pop button', { hasText: /send/i }).first().click();
        await page.waitForFunction(() => /queued · [a-f0-9]{12}/.test(document.querySelector('.zmscap-pop')?.textContent || ''), null, { timeout: 10_000 });
        const id = (await page.locator('.zmscap-pop').textContent()).match(/queued · ([a-f0-9]{12})/)[1];
        let status = 'queued';
        for (let i = 0; i < 180 && !/^(done|failed)$/.test(status); i++) {
          await new Promise((r) => setTimeout(r, 500));
          status = (await (await fetch(`${base}/api/agent-note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', job: id }) })).json()).status;
        }
        check(status === 'done', 'draft: a note from the page runs a real codex turn and finishes done', status);
        const calls = seen.filter((c) => c.path.endsWith('/responses'));
        check(calls.length > 0 && calls.every((c) => c.auth === 'Bearer fx-draft-token'), 'draft: the turn used the owner\'s plan token');
        check(calls.some((c) => (JSON.parse(c.body).input || []).some((i) => JSON.stringify(i).includes('Make the headline shorter'))), 'draft: the note reached the model with its element context');
        if (shots) { await page.reload(); await launch.waitFor(); await page.locator('button', { hasText: /notes/i }).last().click().catch(() => {}); await page.screenshot({ path: path.join(shots, '3-tray.png') }); }
      } finally { await browser.close(); }
    }
  } catch (e) { check(false, 'draft journey', e.stack || e.message); }
  finally { await new Promise((r) => dev.server.close(r)); api.close(); }
}

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
await verifyDraft();
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nchatgpt plan engine verified (fixtures only; no OpenAI sign-in or plan usage)');
process.exit(failures ? 1 : 0);
