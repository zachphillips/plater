// Local-only fault bench. Wrangler's config lives outside the package; the
// production Worker never imports this adapter. D1, KV and send_email are real
// local Miniflare bindings. No request or email can reach a live service.
import worker from '../packages/list-worker/worker.js';
import { EmailMessage } from 'cloudflare:email';

const json = (body) => Response.json(body);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function entries(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const { name } of page.keys) out.push({ key: name, value: await kv.get(name, 'json') });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

function instrument(env, faults, requestId) {
  const audit = async (event, detail = {}) => {
    await env.BENCH.put(`event:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify({ event, requestId, ...detail }));
  };
  const beforeDb = async () => {
    await audit('db_started');
    if (faults.dbDelayMs) await delay(faults.dbDelayMs);
    if (faults.dbFail) throw new Error('bench: D1 refused (7500)');
  };
  const afterDb = async (value) => { await audit('db_saved'); return value; };
  const statement = (sql) => {
    const wrap = (stmt) => new Proxy(stmt, { get(target, key) {
      if (key === 'bind') return (...args) => wrap(target.bind(...args));
      if (['first', 'run', 'all', 'raw'].includes(key)) return async (...args) => {
        await beforeDb();
        return afterDb(await target[key](...args));
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return wrap(env.DB.prepare(sql));
  };
  return { ...env,
    DB: { prepare: statement, batch: async (statements) => {
      await beforeDb();
      const value = await afterDb(await env.DB.batch(statements));
      if (faults.dbFailAfterCommit) throw new Error('bench: lost D1 acknowledgement after commit');
      return value;
    } },
    GAPS: faults.gapsFail ? { ...env.GAPS, put: async () => { throw new Error('bench: KV refused'); } } : env.GAPS,
    RELAY: { send: async (message) => {
      await audit('relay_started');
      if (faults.relayDelayMs) await delay(faults.relayDelayMs);
      if (faults.relayFail) throw new Error('bench: mail refused');
      // Miniflare exposes the raw MIME on this local EmailMessage field.
      const raw = await new Response(message['EmailMessage::raw']).text();
      await env.RELAY.send(new EmailMessage(message.from, message.to, raw));
      await audit('relay_sent', { raw });
    } },
  };
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === '/__bench/seed-export' && req.method === 'POST') {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS subscribers (site TEXT NOT NULL, email TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, confirmed INTEGER DEFAULT 1, unsubscribed_at TEXT, PRIMARY KEY (site, email))').run();
      await env.DB.batch(Array.from({ length: 501 }, (_, i) => env.DB.prepare('INSERT INTO subscribers (site, email, note, created_at) VALUES (?1, ?2, ?3, ?4)').bind('demo', `person-${String(i).padStart(4, '0')}@example.com`, 'Original complete inquiry', '2026-01-01T00:00:00.000Z')));
      return json({ seeded: 501 });
    }
    if (path === '/__bench/hold-delayed' && req.method === 'POST') {
      const sub = { site: 'demo', email: 'delayed@example.com', note: 'Complete delayed inquiry', created_at: '2020-01-01T00:00:00.000Z' };
      await env.GAPS.put('gap:local-delayed', JSON.stringify({ sub, missing: ['db', 'relay'], reasons: {}, recorded_at: new Date().toISOString() }));
      return json({ held: true });
    }
    if (path === '/__bench/seed-legacy' && req.method === 'POST') {
      await env.DB.prepare('CREATE TABLE subscribers (site TEXT NOT NULL, email TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, confirmed INTEGER DEFAULT 1, unsubscribed_at TEXT, PRIMARY KEY (site, email))').run();
      await env.DB.prepare("INSERT INTO subscribers (site, email, note, created_at) VALUES ('demo', 'legacy@example.com', 'Existing inquiry to retain', '2026-01-01T00:00:00.000Z')").run();
      return json({ ok: true });
    }
    if (path === '/__bench/faults' && req.method === 'POST') {
      const faults = await req.json();
      await env.BENCH.put('faults', JSON.stringify(faults));
      return json({ faults });
    }
    if (path === '/__bench/state') {
      const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('subscribers', 'submission_notes')").all();
      const rows = table.results.some((t) => t.name === 'subscribers')
        ? (await env.DB.prepare('SELECT * FROM subscribers ORDER BY email').all()).results : [];
      return json({ rows, gaps: await entries(env.GAPS, 'gap:'), events: await entries(env.BENCH, 'event:') });
    }
    if (path === '/') return new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>Local list Worker proof</title><h1>Local list Worker proof</h1><p>Synthetic submissions. Local D1, KV and simulated mail only.</p><pre id="results" style="white-space:pre-wrap"></pre>', { headers: { 'content-type': 'text/html' } });
    const faults = await env.BENCH.get('faults', 'json') || {};
    return worker.fetch(req, instrument(env, faults, req.headers.get('x-bench-id') || crypto.randomUUID()), ctx);
  },
  async scheduled(event, env, ctx) {
    const faults = await env.BENCH.get('faults', 'json') || {};
    return worker.scheduled(event, instrument(env, faults, 'repair'), ctx);
  },
};
