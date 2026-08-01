// GET /api/config — reports CMS capabilities to the client.
// Never exposes the edit token itself, only whether that auth path is available.
const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || '').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  res.setHeader('cache-control', 'no-cache');
  res.status(200).json({
    googleClientId: GOOGLE_CLIENT_ID,
    adminEmail: ADMIN_EMAIL,
    editable: Boolean(GOOGLE_CLIENT_ID) || Boolean(EDIT_TOKEN),
    tokenAuth: Boolean(EDIT_TOKEN),
    devNoauth: false,
    // Advertises the agent-routing feature to the client when an agent-host
    // endpoint is configured. The endpoint URL/secret are never sent here.
    agentRouting: Boolean(process.env.PLATER_AGENT_ENDPOINT || process.env.ZMS_AGENT_ENDPOINT),
  });
}
