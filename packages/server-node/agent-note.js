// POST /api/agent-note — the public note-routing relay.
//
// The browser (an authenticated CMS admin) posts a captured note here, to the
// SITE'S OWN origin, using the same auth it uses to save (edit token or Google
// ID token). This handler verifies that, then forwards the note to the Plater
// agent host (behind a Cloudflare Tunnel) using a server-side bearer
// secret the browser never sees. The site is forced to CMS_SITE_NAME so a
// caller can't target another site's repo.
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || '').toLowerCase();
// Commits need a valid git identity even when the shared edit token (which
// carries no email) is the credential used.
const COMMIT_EMAIL = ADMIN_EMAIL || 'plater@users.noreply.github.com';
const SIGN_IN = ADMIN_EMAIL ? `sign in as ${ADMIN_EMAIL}` : 'sign in with the authorized account';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
// ZMS_* are the deprecated-but-supported aliases, same as PLATER_WEB_ROOT.
const AGENT_ENDPOINT = process.env.PLATER_AGENT_ENDPOINT || process.env.ZMS_AGENT_ENDPOINT || '';
const AGENT_TOKEN = process.env.PLATER_AGENT_TOKEN || process.env.ZMS_AGENT_TOKEN || '';
const SITE = process.env.CMS_SITE_NAME || 'site';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogle(idToken) {
  try {
    // Fail CLOSED: with no CMS_ADMIN_EMAIL configured there is no one to
    // authorize, so an empty allowlist must never match an empty token email.
    if (!ADMIN_EMAIL) return false;
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
  if (!auth) return res.status(401).json({ error: `${SIGN_IN} to send a note` });

  let ok = false;
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) ok = true;
  else ok = await verifyGoogle(auth);
  if (!ok) return res.status(401).json({ error: 'auth failed' });

  if (!AGENT_ENDPOINT || !AGENT_TOKEN) return res.status(501).json({ error: 'agent routing not configured (set PLATER_AGENT_ENDPOINT + PLATER_AGENT_TOKEN)' });

  const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  // Design-loop passthroughs (relayed with the same forced-site + server-side
  // bearer contract as notes):
  //   { action: "design", note, capture }            → images, not code
  //   { action: "status", job: "<id>" }              → poll a job
  //   { action: "image", job: "<id>", n: 1 }         → one alternative PNG
  //   { action: "accept", designJob, alternative, note?, route? } → build it
  const action = body.action || 'note';
  const base = AGENT_ENDPOINT.replace(/\/$/, '');

  try {
    if (action === 'status') {
      if (!/^[a-f0-9]+$/.test(String(body.job || ''))) return res.status(400).json({ error: 'bad job id' });
      const r = await fetch(`${base}/jobs/${body.job}`, { headers: { authorization: 'Bearer ' + AGENT_TOKEN } });
      return res.status(r.status).json(await r.json().catch(() => ({})));
    }
    if (action === 'image') {
      if (!/^[a-f0-9]+$/.test(String(body.job || '')) || !Number.isInteger(body.n)) return res.status(400).json({ error: 'bad image ref' });
      const r = await fetch(`${base}/design/${body.job}/alt-${body.n}.png`, { headers: { authorization: 'Bearer ' + AGENT_TOKEN } });
      if (!r.ok) return res.status(r.status).json({ error: 'image not available' });
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'private, max-age=3600');
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
    if (action === 'accept') {
      const payload = { designJob: String(body.designJob || ''), alternative: Number(body.alternative), note: body.note, route: body.route || {} };
      const r = await fetch(`${base}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AGENT_TOKEN },
        body: JSON.stringify(payload),
      });
      return res.status(r.status).json(await r.json().catch(() => ({})));
    }

    if (!body.note || typeof body.note !== 'string') return res.status(400).json({ error: 'note text required' });
    // site is forced server-side; the client cannot choose which repo to target.
    const payload = { site: SITE, note: body.note.slice(0, 4000), capture: body.capture || {}, route: body.route || {} };
    const r = await fetch(`${base}/${action === 'design' ? 'design' : 'note'}`, {
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
