// Local HTTP bench for the real standalone handlers. Only Google's tokeninfo
// data is synthetic; no credential or request can reach an external service.
// Empty write bodies prove whether the auth gate was passed without writing.
import http from 'node:http';

const port = Number(process.env.PORT || 24221);
const endpoints = ['save', 'history', 'upload', 'review', 'versions', 'agent-note', 'propose-post'];
const modes = ['missing-client', 'configured', 'missing-admin', 'edit-token'];
const handlers = new Map();
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
    const token = url.searchParams.get('id_token');
    calls.push({ service: 'synthetic tokeninfo', token });
    return Response.json({ email: 'owner@example.com', email_verified: 'true', aud: token === 'right-client' ? 'plater-client' : 'another-client', exp: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.hostname !== '127.0.0.1') throw new Error('auth bench refuses external requests');
  return realFetch(input, init);
};
for (const key of ['GITHUB_TOKEN', 'CMS_GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'CMS_DEPLOY_HOOK', 'PLATER_AGENT_ENDPOINT', 'ZMS_AGENT_ENDPOINT', 'PLATER_AGENT_TOKEN', 'ZMS_AGENT_TOKEN']) delete process.env[key];
for (const mode of modes) {
  process.env.CMS_ADMIN_EMAIL = mode === 'missing-admin' ? '' : 'owner@example.com';
  process.env.GOOGLE_CLIENT_ID = ['configured', 'missing-admin'].includes(mode) ? 'plater-client' : '';
  process.env.CMS_EDIT_TOKEN = mode === 'edit-token' ? 'synthetic-edit-token' : '';
  for (const endpoint of [...endpoints, 'config']) {
    const { default: handler } = await import(`../packages/server-node/${endpoint}.js?auth-bench=${mode}`);
    handlers.set(`/${mode}/${endpoint}`, handler);
  }
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Local authorization proof</title><h1>Local authorization proof</h1><p>Real handlers, synthetic tokeninfo only. Empty bodies cannot write content.</p><pre id="results" style="white-space:pre-wrap"></pre>');
  }
  if (pathname === '/calls') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(calls)); }
  const handler = handlers.get(pathname);
  if (!handler) { res.statusCode = 404; return res.end('not found'); }
  let body = '';
  for await (const chunk of req) body += chunk;
  req.body = body;
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res; };
  try { await handler(req, res); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
