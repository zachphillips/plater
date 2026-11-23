// A local stand-in for Anthropic's POST /v1/messages, for proving the edit
// assistant (/api/assist) without a key and without spending anything.
//
// It answers the shapes the real API answers: a Messages response with a
// thinking block before the text block (read by type, not position), a
// structured-output JSON text block and a full `usage` block; and the errors
// the assistant has to handle: 400 when a key needs a workspace and none was
// sent, 429 rate limited (with retry-after), 529 overloaded. Error bodies carry
// no usage block, as on the real API, so they must never reach the usage log.
// The 400 wording is the stand-in's own; the real text is on Anthropic's
// authentication page.
//
//   const s = await startStandin()     s.url, s.requests (every body + headers
//                                      seen), s.setMode('ok'|'400'|'429'|'529'),
//                                      s.requireWorkspace(true), s.close()
//   node verify/assist-standin.mjs     run it alone, print its URL
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Deterministic "rewrites" so a proof can show something plausible.
function rewrite(text, instruction) {
  const i = instruction.toLowerCase();
  if (/spanish/.test(i)) {
    const known = {
      'Edit this page in the browser.': 'Edita esta página en el navegador.',
    };
    return known[text] || `(ES) ${text}`;
  }
  if (/short/.test(i)) return text.split(/(?<=[.!?])\s+/)[0].replace(/,.*?(\.|$)/, '$1');
  if (/warm/.test(i)) return text.replace(/\.$/, '') + ', with nothing in your way.';
  if (/plain/.test(i)) return text.replace(/contenteditable/gi, 'in-place');
  return text.replace(/\.$/, '') + ' (rewritten).';
}

export async function startStandin({ port = 0, model = null } = {}) {
  let mode = 'ok';
  let needWorkspace = false;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null; try { body = JSON.parse(raw); } catch {}
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, raw, body });
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_standin_' + crypto.randomBytes(6).toString('hex'), ...extra });
      res.end(JSON.stringify(obj));
    };
    const err = (status, type, message, extra) => send(status, { type: 'error', error: { type, message }, request_id: 'req_standin' }, extra);
    // Control for a journey running in another process: POST /__mode/<mode>.
    const ctl = req.url.match(/^\/__mode\/(ok|400|429|529)$/);
    if (ctl && req.method === 'POST') { requests.pop(); mode = ctl[1]; return send(200, { mode }); }
    if (req.url === '/__requests' && req.method === 'GET') { requests.pop(); return send(200, requests.map((r) => ({ headers: r.headers, raw: r.raw }))); }
    if (req.method !== 'POST' || req.url !== '/v1/messages') return err(404, 'not_found_error', 'Not found');
    if (!req.headers['x-api-key']) return err(401, 'authentication_error', 'x-api-key header is required');
    if (!req.headers['anthropic-version']) return err(400, 'invalid_request_error', 'anthropic-version header is required');
    if (mode === '400' || (needWorkspace && !req.headers['anthropic-workspace-id'])) {
      return err(400, 'invalid_request_error', 'This API key is not scoped to a workspace. Send the anthropic-workspace-id header to choose one.');
    }
    if (mode === '429') return err(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit.', { 'retry-after': '20' });
    if (mode === '529') return err(529, 'overloaded_error', 'Overloaded');
    const user = String(body?.messages?.[0]?.content || '');
    const text = (user.match(/Current text:\n([\s\S]*?)\n\nInstruction:/) || [])[1] || '';
    const instruction = (user.match(/Instruction: (.*)$/m) || [])[1] || '';
    const replacement = rewrite(text, instruction);
    // Plausible counts: about four characters a token.
    const inTok = Math.ceil((JSON.stringify(body?.system || '').length + user.length) / 4) + 180;
    const outTok = Math.ceil(replacement.length / 4) + 14;
    send(200, {
      id: 'msg_standin_' + crypto.randomBytes(8).toString('hex'),
      type: 'message',
      role: 'assistant',
      model: model || body?.model,
      content: [
        { type: 'thinking', thinking: '', signature: 'standin-signature' },
        { type: 'text', text: JSON.stringify({ replacement }) },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: inTok,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        output_tokens: outTok,
        service_tier: 'standard',
        server_tool_use: null,
      },
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setMode(m) { mode = m; },
    requireWorkspace(on) { needWorkspace = Boolean(on); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const entry = (() => { try { return fs.realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const s = await startStandin({ port: Number(process.env.PORT) || 0 });
  console.log(JSON.stringify({ url: s.url }));
}
