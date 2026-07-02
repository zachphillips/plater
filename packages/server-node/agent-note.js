// POST /api/agent-note — the public note-routing relay.
//
// The browser (an authenticated CMS admin) posts a captured note here, to the
// SITE'S OWN origin, using the same auth it uses to save (edit token or Google
// ID token). This handler verifies that, then forwards the note to the ZMS
// agent host (Trapjaw, behind a Cloudflare Tunnel) using a server-side bearer
// secret the browser never sees. The site is forced to CMS_SITE_NAME so a
// caller can't target another site's repo.
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || 'zach@thekitchen.co').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
const AGENT_ENDPOINT = process.env.ZMS_AGENT_ENDPOINT || '';
const AGENT_TOKEN = process.env.ZMS_AGENT_TOKEN || '';
const SITE = process.env.CMS_SITE_NAME || 'site';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogle(idToken) {
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!r.ok) return false;
    const t = await r.json();
    if (GOOGLE_CLIENT_ID && t.aud !== GOOGLE_CLIENT_ID) return false;
    if (String(t.email_verified) !== 'true') return false;
    if ((t.email || '').toLowerCase() !== ADMIN_EMAIL) return false;
    if (t.exp && Math.floor(Date.now() / 1000) > Number(t.exp)) return false;
    return true;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return res.status(401).json({ error: `sign in as ${ADMIN_EMAIL} to send a note` });

  let ok = false;
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) ok = true;
  else ok = await verifyGoogle(auth);
  if (!ok) return res.status(401).json({ error: 'auth failed' });

  if (!AGENT_ENDPOINT || !AGENT_TOKEN) return res.status(501).json({ error: 'agent routing not configured (set ZMS_AGENT_ENDPOINT + ZMS_AGENT_TOKEN)' });

  const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  if (!body.note || typeof body.note !== 'string') return res.status(400).json({ error: 'note text required' });

  // site is forced server-side; the client cannot choose which repo to target.
  const payload = { site: SITE, note: body.note.slice(0, 4000), capture: body.capture || {}, route: body.route || {} };

  try {
    const r = await fetch(AGENT_ENDPOINT.replace(/\/$/, '') + '/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AGENT_TOKEN },
      body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    return res.status(r.status).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'agent host unreachable: ' + e.message });
  }
}
