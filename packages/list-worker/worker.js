// plater-list — the fleet's email-capture backend. One Cloudflare Worker + D1,
// shared by every site; rows are namespaced by site key. Replaces the mailto:
// stopgaps ("Keep me posted" on sherwood/TGR, the Kitchen inquiry form).
//
// Philosophy-fit: this is plumbing, not a marketing suite. It captures, it
// exports, it deletes. No campaigns, no segments, no tracking pixels.
//
// Endpoints:
//   POST /subscribe          { site, email, note? }   → 200 { ok:true }
//     - site must be in the SITES allowlist (env, comma-separated)
//     - idempotent: re-subscribing the same email is a 200, not a dupe row
//     - honeypot: a non-empty `company` field silently succeeds w/o storing
//     - if the site has a SINK configured, the capture is also forwarded
//       there (fire-and-forget; D1 remains the durable record either way)
//   GET  /list?site=…        Bearer LIST_ADMIN_TOKEN  → { rows: […] }
//   GET  /export?site=…&since=<iso>  Bearer LIST_ADMIN_TOKEN
//     → { rows, cursor } — incremental drain for PULL consumers that can't
//       receive webhooks (the Elsewhere vault binds 127.0.0.1 by design, so
//       a bridge script on the owner's machine polls this and inserts
//       locally; see elsewhere-bridge.mjs)
//   POST /unsubscribe        { site, email }          → 200 (also Bearer-free:
//     unsubscribing must never require credentials)
//   GET  /health             → { ok, sites }
//
// SINKS (env, JSON): per-site "send captures to MY provider" — any provider
// that accepts an HTTP POST (Buttondown, Mailchimp, ConvertKit, a personal
// webhook…). The worker stays plumbing: it forwards, it never syncs back.
//   SINKS = {"greatrebellion": {
//     "url": "https://api.buttondown.email/v1/subscribers",
//     "headers": {"Authorization": "Token …"},
//     "body": {"email_address": "{{email}}", "notes": "{{note}}", "tags": ["{{site}}"]}
//   }}
// {{email}} / {{note}} / {{site}} / {{created_at}} are replaced in any string
// value of `body` (defaults to {email, note, site, created_at} when omitted).
//
// D1 schema (auto-migrated on first request):
//   CREATE TABLE subscribers (
//     site TEXT NOT NULL, email TEXT NOT NULL, note TEXT,
//     created_at TEXT NOT NULL, confirmed INTEGER DEFAULT 1,
//     unsubscribed_at TEXT, PRIMARY KEY (site, email))
//
// CORS: allow-listed site origins only (SITES maps key→origin).

const MIGRATION = `CREATE TABLE IF NOT EXISTS subscribers (
  site TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  confirmed INTEGER DEFAULT 1,
  unsubscribed_at TEXT,
  PRIMARY KEY (site, email)
)`;

function parseSites(env) {
  // SITES = "sherwood=https://sherwood.thekitchen.co,greatrebellion=https://greatrebellion.net"
  const map = {};
  for (const pair of String(env.SITES || '').split(',')) {
    const [k, v] = pair.split('=').map((s) => s && s.trim());
    if (k && v) map[k] = v.replace(/\/$/, '');
  }
  return map;
}

function corsHeaders(origin, sites) {
  const allowed = Object.values(sites).includes(origin) ? origin : '';
  return {
    ...(allowed ? { 'access-control-allow-origin': allowed, vary: 'origin' } : {}),
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const sites = parseSites(env);
    const cors = corsHeaders(req.headers.get('origin') || '', sites);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    await env.DB.prepare(MIGRATION).run();

    if (url.pathname === '/health') {
      return json({ ok: true, sites: Object.keys(sites) }, 200, cors);
    }

    if (url.pathname === '/subscribe' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'json body required' }, 400, cors); }
      const site = String(body.site || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const note = String(body.note || '').slice(0, 500) || null;
      if (!sites[site]) return json({ error: 'unknown site' }, 400, cors);
      if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: 'that does not look like an email address' }, 400, cors);
      // honeypot: bots fill every field; humans never see `company`
      if (body.company) return json({ ok: true }, 200, cors);
      const created_at = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO subscribers (site, email, note, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (site, email) DO UPDATE SET unsubscribed_at = NULL`,
      ).bind(site, email, note, created_at).run();
      // Per-site sink: forward to the owner's own provider, after the response
      // (waitUntil) — the visitor never waits on a third party, and D1 already
      // holds the durable record if the sink is down.
      const sink = parseSinks(env)[site];
      if (sink && sink.url) {
        ctx.waitUntil(forwardToSink(sink, { email, note: note || '', site, created_at }).catch(() => {}));
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
      const auth = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.LIST_ADMIN_TOKEN || !timingSafeEqualStr(auth, env.LIST_ADMIN_TOKEN)) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
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
      const auth = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.LIST_ADMIN_TOKEN || !timingSafeEqualStr(auth, env.LIST_ADMIN_TOKEN)) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      const site = String(url.searchParams.get('site') || '').trim();
      const rows = site
        ? (await env.DB.prepare('SELECT * FROM subscribers WHERE site = ?1 ORDER BY created_at DESC').bind(site).all()).results
        : (await env.DB.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all()).results;
      return json({ rows }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
