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
//   GET  /list?site=…        Bearer LIST_ADMIN_TOKEN  → { rows: […] }
//   POST /unsubscribe        { site, email }          → 200 (also Bearer-free:
//     unsubscribing must never require credentials)
//   GET  /health             → { ok, sites }
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
  async fetch(req, env) {
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
      await env.DB.prepare(
        `INSERT INTO subscribers (site, email, note, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (site, email) DO UPDATE SET unsubscribed_at = NULL`,
      ).bind(site, email, note, new Date().toISOString()).run();
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
