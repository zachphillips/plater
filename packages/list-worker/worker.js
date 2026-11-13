// plater-list — an email-capture backend. One Cloudflare Worker + D1, shared by
// every site you run; rows are namespaced by site key. Replaces the mailto:
// stopgap that every small site starts with.
//
// Philosophy-fit: this is plumbing, not a marketing suite. It captures, it
// exports, it deletes. No campaigns, no segments, no tracking pixels.
//
// A sign-up or inquiry is never only in the database (capture.js holds the
// rule and its reasons). Each accepted submission is written to D1 AND emailed
// to the owner through the RELAY send_email binding before the Worker answers.
// The full submission goes to GAPS KV before delivery so a Worker restart is
// repairable. "ok" means at least one place took it, with a journal for any
// unfinished delivery. The hourly scheduled run repairs it. A D1
// refusal (for example the free plan's daily limit) is caught, logged, named
// in the email, and never becomes a response the page cannot read: every
// response carries the CORS headers.
//
// Endpoints:
//   POST /subscribe          { site, email, note? }   → 200 { ok:true }
//     - site must be in the SITES allowlist (env, comma-separated)
//     - idempotent: re-subscribing the same email is a 200, not a dupe row; a
//       new, different note is appended to the existing row's note, dated
//     - the note is stored whole; past NOTE_MAX characters (50,000) the
//       request is refused with a plain 413 message, never cut
//     - honeypot: a non-empty `company` field silently succeeds w/o storing
//     - 503 { error } when neither D1 nor the relay took it, or a lone copy
//       has no repair journal (the page's own fallback runs)
//     - if the site has a SINK configured, the capture is also forwarded
//       there afterwards (fire-and-forget)
//   GET  /list?site=…        Bearer LIST_ADMIN_TOKEN  → { rows: […] }
//   GET  /export?site=…&since=<iso>  Bearer LIST_ADMIN_TOKEN
//     → { rows, cursor } — incremental drain for PULL consumers that can't
//       receive webhooks (e.g. a local-only vault that binds 127.0.0.1 by
//       design, so a bridge script on the owner's machine polls this and
//       inserts locally; see elsewhere-bridge.mjs)
//   GET  /gaps               Bearer LIST_ADMIN_TOKEN  → { gaps: […] } submissions
//     that are missing from one place and waiting for the repair run
//   POST /unsubscribe        { site, email }          → 200 (also Bearer-free:
//     unsubscribing must never require credentials)
//   GET  /health             → { ok, sites, relay, gaps } (never touches D1)
//   scheduled (cron, hourly) → repair every gap record it can, then delete it
//
// Configuration (all optional except DB and SITES):
//   SITES       "key=https://origin,key=https://another-origin,…" — a key may
//               repeat, so one site can be posted from several addresses
//   RELAY       send_email binding (Cloudflare Email Routing). On the free plan
//               it sends only to a verified destination address on the account,
//               from an address on a domain with Email Routing enabled.
//   RELAY_FROM  sender address on that domain, e.g. list@example.com
//   RELAY_TO    the owner's verified destination address
//   GAPS        KV namespace for gap records
//   LIST_ADMIN_TOKEN  secret for /list, /export, /gaps
//   SINKS       see below
//
// SINKS (env, JSON): per-site "send captures to MY provider" — any provider
// that accepts an HTTP POST (Buttondown, Mailchimp, ConvertKit, a personal
// webhook…). The worker stays plumbing: it forwards, it never syncs back.
//   SINKS = {"my-site": {
//     "url": "https://api.buttondown.email/v1/subscribers",
//     "headers": {"Authorization": "Token …"},
//     "body": {"email_address": "{{email}}", "notes": "{{note}}", "tags": ["{{site}}"]}
//   }}
// {{email}} / {{note}} / {{site}} / {{created_at}} are replaced in any string
// value of `body` (defaults to {email, note, site, created_at} when omitted).
//
// D1 schema (created the first time a write finds no table; not run on every
// request, so a refusing database costs one failed statement, not two):
//   CREATE TABLE subscribers (
//     site TEXT NOT NULL, email TEXT NOT NULL, note TEXT,
//     created_at TEXT NOT NULL, confirmed INTEGER DEFAULT 1,
//     unsubscribed_at TEXT, PRIMARY KEY (site, email))
//
// CORS: allow-listed site origins only (SITES maps key→origins).

import { BODY_MAX, TOO_LONG, capture, readSubmission, relayMime } from './capture.js';

const MIGRATION = `CREATE TABLE IF NOT EXISTS subscribers (
  site TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  confirmed INTEGER DEFAULT 1,
  unsubscribed_at TEXT,
  PRIMARY KEY (site, email)
)`;

// Exact submitted-message identities, committed atomically with the list row.
// Looking for a substring in the accumulated note loses distinct inquiries.
const NOTES_MIGRATION = `CREATE TABLE IF NOT EXISTS submission_notes (
  site TEXT NOT NULL, email TEXT NOT NULL, note_hash TEXT NOT NULL,
  PRIMARY KEY (site, email, note_hash)
)`;

// A repeat sign-up keeps the original row and date. A new message from the
// same address is appended, dated, so a second inquiry is never dropped; the
// same message sent twice is not appended again.
const UPSERT = `INSERT INTO subscribers (site, email, note, created_at) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (site, email) DO UPDATE SET
    unsubscribed_at = NULL,
    note = CASE
      WHEN excluded.note IS NULL OR excluded.note = '' THEN subscribers.note
      WHEN subscribers.note IS NULL OR subscribers.note = '' THEN excluded.note
      WHEN subscribers.note = excluded.note THEN subscribers.note
      WHEN EXISTS (SELECT 1 FROM submission_notes WHERE site = excluded.site AND email = excluded.email AND note_hash = ?5) THEN subscribers.note
      ELSE subscribers.note || char(10) || char(10) || '[' || excluded.created_at || '] ' || excluded.note
    END
  RETURNING created_at`;

function parseSites(env) {
  // SITES = "my-site=https://my-site.com,my-site=https://www.my-site.com,another=https://another.example"
  const map = {};
  for (const pair of String(env.SITES || '').split(',')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim().replace(/\/$/, '');
    if (k && v) (map[k] ||= []).push(v);
  }
  return map;
}

function corsHeaders(origin, sites) {
  const allowed = origin && Object.values(sites).some((list) => list.includes(origin)) ? origin : '';
  return {
    ...(allowed ? { 'access-control-allow-origin': allowed } : {}),
    vary: 'origin',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

const errText = (e) => String((e && e.message) || e || 'unknown error').slice(0, 500);

function parseSinks(env) {
  try { return JSON.parse(env.SINKS || '{}'); } catch { return {}; }
}

function fillTemplate(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return value;
}

async function forwardToSink(sink, vars) {
  const body = sink.body ? fillTemplate(sink.body, vars)
    : { email: vars.email, note: vars.note, site: vars.site, created_at: vars.created_at };
  const r = await fetch(sink.url, {
    method: sink.method || 'POST',
    headers: { 'content-type': 'application/json', ...(sink.headers || {}) },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status };
}

function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const isAdmin = (req, env) => {
  const auth = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.LIST_ADMIN_TOKEN) && timingSafeEqualStr(auth, env.LIST_ADMIN_TOKEN);
};

// Run a D1 write; if the table does not exist yet (a new install), create it
// and try once more. Any other refusal propagates to the caller.
async function withTable(env, fn) {
  try { return await fn(); } catch (e) {
    if (!/no such table/i.test(errText(e))) throw e;
    await env.DB.batch([env.DB.prepare(MIGRATION), env.DB.prepare(NOTES_MIGRATION)]);
    return fn();
  }
}

async function saveToDb(env, sub) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.note || ''));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const result = await withTable(env, () => env.DB.batch([
    env.DB.prepare(UPSERT).bind(sub.site, sub.email, sub.note, sub.created_at, hash),
    env.DB.prepare('INSERT OR IGNORE INTO submission_notes (site, email, note_hash) VALUES (?1, ?2, ?3)').bind(sub.site, sub.email, hash),
  ]));
  const row = result[0].results[0];
  return { fresh: !row || row.created_at === sub.created_at };
}

async function sendRelay(env, sub, db, delayed = false) {
  const { EmailMessage } = await import('cloudflare:email');
  const { raw } = relayMime({ from: env.RELAY_FROM, to: env.RELAY_TO, sub, db, delayed });
  await env.RELAY.send(new EmailMessage(env.RELAY_FROM, env.RELAY_TO, raw));
}

async function recordGap(env, sub, missing, reasons) {
  const key = `gap:${sub.created_at}:${sub.site}:${crypto.randomUUID().slice(0, 8)}`;
  await env.GAPS.put(key, JSON.stringify({ sub, missing, reasons, recorded_at: new Date().toISOString() }));
  return key;
}

function placesFor(env, ctx) {
  const relayReady = Boolean(env.RELAY && env.RELAY_FROM && env.RELAY_TO);
  return {
    saveToDb: (sub) => saveToDb(env, sub),
    relay: relayReady ? (sub, db) => sendRelay(env, sub, db) : undefined,
    recordGap: env.GAPS ? (sub, missing, reasons) => recordGap(env, sub, missing, reasons) : undefined,
    clearGap: env.GAPS ? (key) => env.GAPS.delete(key) : undefined,
    waitUntil: ctx ? (work) => ctx.waitUntil(work) : undefined,
  };
}

// Hourly: put every held submission into the place it missed. Reads D1 only
// when there is something to repair. A record is rewritten only when what is
// missing changes, so a long outage does not spend the KV write allowance.
async function repairGaps(env) {
  if (!env.GAPS) return { checked: 0, repaired: 0, waiting: 0 };
  const places = placesFor(env);
  let cursor, checked = 0, repaired = 0, waiting = 0;
  do {
    const page = await env.GAPS.list({ prefix: 'gap:', cursor });
    for (const { name } of page.keys) {
      const rec = await env.GAPS.get(name, 'json');
      if (!rec || !rec.sub) continue;
      checked++;
      const still = [];
      let db = { ok: !rec.missing.includes('db') };
      if (rec.missing.includes('db')) {
        try { db = { ok: true, ...(await places.saveToDb(rec.sub)) }; }
        catch (e) { db = { ok: false, error: errText(e) }; still.push('db'); }
      }
      if (rec.missing.includes('relay')) {
        if (!places.relay) still.push('relay');
        else {
          try { await sendRelay(env, rec.sub, db, true); }
          catch { still.push('relay'); }
        }
      }
      if (!still.length) { await env.GAPS.delete(name); repaired++; }
      else {
        waiting++;
        if (still.length !== rec.missing.length) {
          await env.GAPS.put(name, JSON.stringify({ ...rec, missing: still, last_repair_at: new Date().toISOString() }));
        }
        console.error(JSON.stringify({ event: 'gap_waiting', site: rec.sub.site, missing: still, db: db.error }));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  console.log(JSON.stringify({ event: 'repair', checked, repaired, waiting }));
  return { checked, repaired, waiting };
}

async function handle(req, env, ctx, sites, cors) {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    return json({ ok: true, sites: Object.keys(sites), relay: Boolean(env.RELAY && env.RELAY_FROM && env.RELAY_TO), gaps: Boolean(env.GAPS) }, 200, cors);
  }

  if (url.pathname === '/subscribe' && req.method === 'POST') {
    if (Number(req.headers.get('content-length') || 0) > BODY_MAX) return json({ error: TOO_LONG }, 413, cors);
    // Count actual bytes while streaming. Chunked requests have no trustworthy
    // Content-Length; reading req.text() first would allow unbounded allocation.
    const reader = req.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > BODY_MAX) { reader.cancel().catch(() => {}); return json({ error: TOO_LONG }, 413, cors); }
        chunks.push(value);
      }
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(all);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'json body required' }, 400, cors); }
    if (!body || typeof body !== 'object') return json({ error: 'json body required' }, 400, cors);
    const read = readSubmission(body, sites);
    if (read.error) return json({ error: read.error }, read.status, cors);
    // honeypot: bots fill every field; humans never see `company`
    if (body.company) return json({ ok: true }, 200, cors);

    const sub = read.sub;
    const result = await capture(sub, placesFor(env, ctx));
    // Logged without the address. A refusal is also named in the email itself.
    const log = { event: 'capture', site: sub.site, db: result.db.ok ? 'saved' : result.db.error,
      relay: result.relay.configured ? (result.relay.ok ? 'sent' : result.relay.error) : 'not configured',
      gap: result.gap, gapError: result.gapError, missing: result.missing };
    (result.missing.length ? console.error : console.log)(JSON.stringify(log));

    if (!result.ok) {
      return json({ error: 'We could not confirm that your message was safely received. Please email it instead.' }, 503, cors);
    }
    // Per-site sink: forward to the owner's own provider, after the response
    // (waitUntil). The visitor never waits on a third party.
    const sink = parseSinks(env)[sub.site];
    if (sink && sink.url) {
      ctx.waitUntil(forwardToSink(sink, { email: sub.email, note: sub.note || '', site: sub.site, created_at: sub.created_at }).catch(() => {}));
    }
    return json({ ok: true }, 200, cors);
  }

  if (url.pathname === '/unsubscribe' && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'json body required' }, 400, cors); }
    const site = String(body.site || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!sites[site]) return json({ error: 'unknown site' }, 400, cors);
    await env.DB.prepare(
      'UPDATE subscribers SET unsubscribed_at = ?3 WHERE site = ?1 AND email = ?2',
    ).bind(site, email, new Date().toISOString()).run();
    return json({ ok: true }, 200, cors);
  }

  // Incremental drain for PULL consumers (e.g. the Elsewhere vault bridge):
  // rows strictly after `since` (ISO), oldest first, plus the next cursor.
  if (url.pathname === '/export' && req.method === 'GET') {
    if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401, cors);
    const site = String(url.searchParams.get('site') || '').trim();
    if (!sites[site]) return json({ error: 'unknown site' }, 400, cors);
    const since = String(url.searchParams.get('since') || '1970-01-01T00:00:00Z');
    const { results } = await env.DB.prepare(
      'SELECT * FROM subscribers WHERE site = ?1 AND created_at > ?2 ORDER BY created_at ASC LIMIT 500',
    ).bind(site, since).all();
    const cursor = results.length ? results[results.length - 1].created_at : since;
    return json({ rows: results, cursor }, 200, cors);
  }

  if (url.pathname === '/list' && req.method === 'GET') {
    if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401, cors);
    const site = String(url.searchParams.get('site') || '').trim();
    const rows = site
      ? (await env.DB.prepare('SELECT * FROM subscribers WHERE site = ?1 ORDER BY created_at DESC').bind(site).all()).results
      : (await env.DB.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all()).results;
    return json({ rows }, 200, cors);
  }

  if (url.pathname === '/gaps' && req.method === 'GET') {
    if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401, cors);
    if (!env.GAPS) return json({ gaps: [] }, 200, cors);
    const gaps = [];
    let cursor;
    do {
      const page = await env.GAPS.list({ prefix: 'gap:', cursor });
      for (const { name } of page.keys) gaps.push({ key: name, ...(await env.GAPS.get(name, 'json')) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ gaps }, 200, cors);
  }

  return json({ error: 'not found' }, 404, cors);
}

export default {
  async fetch(req, env, ctx) {
    const sites = parseSites(env);
    const cors = corsHeaders(req.headers.get('origin') || '', sites);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      return await handle(req, env, ctx, sites, cors);
    } catch (e) {
      // Whatever failed (a refused database on an admin read, an unsubscribe),
      // the page still gets JSON it is allowed to read.
      console.error(JSON.stringify({ event: 'error', path: new URL(req.url).pathname, error: errText(e) }));
      return json({ error: 'The list is having trouble right now. Please try again later or email instead.' }, 503, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(repairGaps(env));
  },
};
