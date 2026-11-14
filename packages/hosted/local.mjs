// Local stand-ins for the hosted Worker's Cloudflare bindings, so the real
// worker.js runs under Node for verification: D1 over node:sqlite (real SQL,
// the real schema.sql), R2 in memory, ASSETS from this repo, and Cloudflare
// Access simulated by a local RSA key that signs the same JWT the edge sends.
// Used by verify/hosted.mjs and test/hosted.test.js; never deployed.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    raw: db,
  };
}

export function r2() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? { arrayBuffer: async () => m.get(k).buffer.slice(m.get(k).byteOffset, m.get(k).byteOffset + m.get(k).byteLength) } : null),
    put: async (k, v) => { m.set(k, Buffer.from(v)); },
    size: () => m.size,
  };
}

export const assets = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const file = p.startsWith('/__plater/') ? path.join(HERE, 'assets', p) : path.join(REPO, p);
    if (!file.startsWith(REPO) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  },
};

// Access: a key pair, a certs document, and signed assertions.
export function access({ team = 'test.cloudflareaccess.com', aud = 'test-aud' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const sign = (claims, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: `https://${team}`, aud: [aud], exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  };
  // Answer the certs request the Worker makes; pass every other fetch through.
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => (String(u) === `https://${team}/cdn-cgi/access/certs`
    ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
    : real(u, init));
  return { team, aud, sign, restore: () => { globalThis.fetch = real; } };
}

// The Worker behind a plain HTTP server. `identity(req)` returns the email the
// simulated Access edge signs in (or null for none), like the real edge would.
export async function serveWorker(worker, env, { identity = () => null, acc }) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const who = identity(req);
    if (who) headers.set('cf-access-jwt-assertion', acc.sign({ email: who }));
    const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half', redirect: 'manual' }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (!r.body) return res.end();
    const reader = r.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch {}
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

export function hostedEnv(acc, extra = {}) {
  return { DB: d1(), BLOBS: r2(), ASSETS: assets, ACCESS_TEAM: acc.team, ACCESS_AUD: acc.aud, OWNER_EMAIL: 'owner@example.test',
    PUBLISH_TOKEN: 'publish-test-token', RUNNER_TOKEN: 'runner-test-token', PUBLIC_URL: '', ...extra };
}
