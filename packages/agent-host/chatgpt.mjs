#!/usr/bin/env node
// node packages/agent-host/chatgpt.mjs <login|status|logout>
//
// The owner's own sign-in for the agent host's `chatgpt` engine (see
// chatgpt-plan.mjs for the eligibility boundary and the three locks).
//
//   login   Starts a one-shot listener on http://127.0.0.1:<random port>/auth/callback,
//           PRINTS the OpenAI sign-in URL and waits. You open it in a browser on
//           THIS machine and approve. Nothing opens a browser or approves for you.
//           On a first sign-in OpenAI registers a client for you and this host
//           (shown on the consent screen as "Plater"); later sign-ins reuse it.
//   status  Shows whether the engine is on, who is signed in and whether plan
//           usage was granted. Never prints a token.
//   logout  Revokes the refresh token with OpenAI, then clears tokens locally.
//           The client id and host id are kept so the next login reuses them.
//
// The engine also needs PLATER_CHATGPT_PLAN=1 on the agent host and
// "planUsage": true on the site in sites.json. Credentials stay on this machine:
// there is deliberately no export/import, and they are never shared with
// another person.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  AUTH_BASE, CALLBACK_PATH, authorizeUrl, buildRecord, exchangeCode, hasPlanGrant, hostId,
  loadRecord, pkce, planDir, randomState, readCallback, saveRecord, verifyIdToken,
} from './chatgpt-plan.mjs';

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Plater</title><body style="font:16px system-ui;margin:3rem">${msg}</body>`;

// Resolves to the saved record (without printing secrets). `print` receives the
// sign-in URL; tests and the verify harness pass their own.
export function login({ dir = planDir(), authBase = AUTH_BASE, fetch: fetchImpl = fetch, port = 0,
  timeoutMs = 10 * 60_000, print = (s) => console.log(s) } = {}) {
  const host = hostId(dir, { create: true });
  const prior = loadRecord(dir);
  const state = randomState(); const nonce = randomState(); const { verifier, challenge } = pkce();
  return new Promise((resolve, reject) => {
    let settled = false;
    const end = (err, value) => {
      if (settled) return; settled = true; clearTimeout(timer); server.close();
      err ? reject(err) : resolve(value);
    };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== CALLBACK_PATH) { res.writeHead(404); return res.end(); }
      try {
        const { code, clientId } = readCallback(req.url, { state, knownClientId: prior?.client_id || null });
        const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
        // Save the issued client id before the exchange, so a retry after an
        // expired code reuses this registration instead of making another.
        if (!prior?.client_id) saveRecord(dir, { client_id: clientId, ext_agent_host_id: host, saved_at: new Date().toISOString() });
        const tokens = await exchangeCode({ fetch: fetchImpl, authBase, clientId, code, verifier, redirectUri });
        const claims = await verifyIdToken(tokens.id_token, { clientId, nonce, fetch: fetchImpl, authBase });
        const record = buildRecord({ prior, clientId, host, tokens, claims });
        saveRecord(dir, record);
        const plan = hasPlanGrant(record);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(plan ? 'Signed in. Plater can use your ChatGPT plan on this machine. You can close this tab.'
          : 'Signed in, but plan usage was not granted. Plater will not use your plan. You can close this tab.'));
        end(null, record);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        // A callback with the wrong state is not ours (a stray request, a prefetch,
        // another site poking the port): refuse it and keep waiting for the real one.
        if (/^state mismatch/.test(e.message)) { res.end(page('This sign-in link is not the one Plater is waiting for.')); return; }
        res.end(page('Sign-in did not complete. Return to the terminal for details.'));
        end(e);
      }
    });
    const timer = setTimeout(() => end(new Error('timed out waiting for sign-in')), timeoutMs);
    server.listen(port, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
      print(authorizeUrl({ record: prior, hostId: host, redirectUri, state, nonce, challenge, authBase }));
    });
  });
}

export function status({ dir = planDir(), env = process.env } = {}) {
  const r = loadRecord(dir);
  return {
    engineEnabled: env.PLATER_CHATGPT_PLAN === '1',
    dir,
    hostId: !!hostId(dir),
    signedIn: !!(r && r.access_token),
    email: r?.email || null,
    planGranted: hasPlanGrant(r),
    expiresAt: r?.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}

export async function logout({ dir = planDir(), authBase = AUTH_BASE, fetch: fetchImpl = fetch } = {}) {
  const r = loadRecord(dir);
  if (!r || !r.refresh_token) return { revoked: false, cleared: false, detail: 'not signed in' };
  let revoked = false; let detail = '';
  try {
    const conf = await (await fetchImpl(`${authBase}/.well-known/openid-configuration`)).json();
    if (!conf.revocation_endpoint) throw new Error('no revocation_endpoint published');
    const res = await fetchImpl(conf.revocation_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: r.refresh_token, token_type_hint: 'refresh_token', client_id: r.client_id }).toString(),
    });
    revoked = res.status === 200;
    if (!revoked) detail = `revocation returned ${res.status}`;
  } catch (e) { detail = e.message; }
  saveRecord(dir, { client_id: r.client_id, ext_agent_host_id: r.ext_agent_host_id, email: r.email, sub: r.sub, issuer: r.issuer, signed_out_at: new Date().toISOString() });
  return { revoked, cleared: true, detail };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'login') {
    const r = await login({
      print: (url) => console.log(`Open this URL in a browser on this machine and approve the request.\nIt is for you only: don't paste it anywhere else.\n\n${url}\n\nWaiting for the sign-in…`),
    });
    console.log(hasPlanGrant(r) ? `Signed in as ${r.email || r.sub}. Plan usage granted.` : `Signed in as ${r.email || r.sub}, but plan usage was NOT granted.`);
  } else if (cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'logout') {
    const out = await logout();
    console.log(out.revoked ? 'Signed out; OpenAI confirmed the revocation.'
      : out.cleared ? `Signed out locally, but OpenAI did not confirm the revocation (${out.detail}). Disconnect Plater in ChatGPT settings to be sure.`
        : out.detail);
  } else {
    console.log('usage: node packages/agent-host/chatgpt.mjs <login|status|logout>');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
