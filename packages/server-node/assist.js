// POST /api/assist — the in-page edit assistant.
//
// A signed-in editor selects one bound element, types a short instruction
// ("shorten this", "make this warmer", "translate to Spanish"), and gets back
// a proposed replacement for that element's text. The browser shows it as a
// pending change; accepting it runs the ordinary hand-edit path (the text is
// typed into the element and autosaved), so this handler never writes content.
//
// Money and privacy are the whole design:
//
//   key       PLATER_ASSIST_ANTHROPIC_KEY, server-side only. ANTHROPIC_API_KEY
//             is never read: Claude Code reads that name, and this credit must
//             never pay for a coding session. No key → /api/config does not
//             advertise the feature and this route answers 501.
//   workspace PLATER_ASSIST_ANTHROPIC_WORKSPACE, when set, goes out as the
//             anthropic-workspace-id header (an organization-wide personal
//             key is refused without it).
//   auth      the same credentials /api/save takes (edit token or Google ID
//             token). Anything else gets 401 before any upstream call.
//   input     only the selected element's text, its tag name and its content
//             path, plus the instruction. Nothing else from the page.
//   caps      PLATER_ASSIST_MAX_TOKENS per call (default 1500), and daily call
//             limits per editor (PLATER_ASSIST_DAILY_PER_EDITOR, default 60)
//             and per site (PLATER_ASSIST_DAILY_PER_SITE, default 200). A slot
//             is reserved before the call, so parallel requests cannot overrun.
//   record    one JSON line per billed response in PLATER_ASSIST_USAGE_LOG:
//             time, site, editor id (a hash, never an email), model and the
//             response's usage block verbatim. No prompt or reply text.
//
// The provider call sits behind callClaude() alone. PLATER_ASSIST_ANTHROPIC_BASE_URL
// points it at a local stand-in for proofs (verify/assist-standin.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || '').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
const SITE = process.env.CMS_SITE_NAME || 'site';

const KEY = process.env.PLATER_ASSIST_ANTHROPIC_KEY || '';
const WORKSPACE = process.env.PLATER_ASSIST_ANTHROPIC_WORKSPACE || '';
const BASE_URL = (process.env.PLATER_ASSIST_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
const MODEL = MODELS.includes(process.env.PLATER_ASSIST_MODEL) ? process.env.PLATER_ASSIST_MODEL : 'claude-sonnet-5-5';
const intEnv = (name, dflt) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : dflt; };
const MAX_TOKENS = intEnv('PLATER_ASSIST_MAX_TOKENS', 1500);
const PER_EDITOR = intEnv('PLATER_ASSIST_DAILY_PER_EDITOR', 60);
const PER_SITE = intEnv('PLATER_ASSIST_DAILY_PER_SITE', 200);
// Server-side refusal fallback (Anthropic's documented default for these
// models). PLATER_ASSIST_FALLBACKS=0 turns it off.
const FALLBACKS = process.env.PLATER_ASSIST_FALLBACKS !== '0';
const USAGE_LOG = process.env.PLATER_ASSIST_USAGE_LOG || path.resolve('.plater-assist-usage.jsonl');
const TIMEOUT_MS = intEnv('PLATER_ASSIST_TIMEOUT_MS', 30000);

// Bounds on what one call can send, so a pasted novel cannot become a bill.
const MAX_TEXT = 6000;
const MAX_INSTRUCTION = 500;

export const assistConfigured = () => Boolean(KEY);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Who is asking, as a stable id with no email in it. The shared edit token
// carries no identity, so everyone on it shares one editor id and one limit.
async function editorFor(bearer) {
  if (!bearer) return null;
  if (EDIT_TOKEN && safeEqual(bearer, EDIT_TOKEN)) return 'edit-token';
  // Fail CLOSED, as in save.js: no admin email means nobody to authorize.
  if (!ADMIN_EMAIL || !GOOGLE_CLIENT_ID) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(bearer));
    if (!r.ok) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID || String(t.email_verified) !== 'true') return null;
    const email = String(t.email || '').toLowerCase();
    if (email !== ADMIN_EMAIL) return null;
    if (t.exp && Math.floor(Date.now() / 1000) > Number(t.exp)) return null;
    return 'google:' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
  } catch { return null; }
}

/* ---------------- daily limits ---------------- */

// Counts live in memory and are seeded from today's lines in the usage log, so
// a restart cannot hand out a fresh allowance for calls already billed.
const day = () => new Date().toISOString().slice(0, 10);
let counts = null;
function todayCounts() {
  const d = day();
  if (counts && counts.day === d) return counts;
  counts = { day: d, site: 0, editors: new Map() };
  try {
    for (const line of fs.readFileSync(USAGE_LOG, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const e = JSON.parse(line);
        if (String(e.time || '').slice(0, 10) !== d || e.site !== SITE) continue;
        counts.site++;
        counts.editors.set(e.editor, (counts.editors.get(e.editor) || 0) + 1);
      } catch {}
    }
  } catch {}
  return counts;
}
function reserve(editor) {
  const c = todayCounts();
  if (c.site >= PER_SITE) return 'site';
  if ((c.editors.get(editor) || 0) >= PER_EDITOR) return 'editor';
  c.site++; c.editors.set(editor, (c.editors.get(editor) || 0) + 1);
  return null;
}
// Upstream failures that billed nothing (no usage block) give the slot back.
function release(editor) {
  const c = todayCounts();
  c.site = Math.max(0, c.site - 1);
  c.editors.set(editor, Math.max(0, (c.editors.get(editor) || 0) - 1));
}

function recordUsage(editor, model, usage) {
  const line = JSON.stringify({ time: new Date().toISOString(), site: SITE, editor, model, usage }) + '\n';
  fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
  fs.appendFileSync(USAGE_LOG, line, { mode: 0o600 });
}

/* ---------------- the provider call ---------------- */

const SYSTEM = [
  'You edit one piece of text on a website for the person who runs the site.',
  'You get the text of a single element, its HTML tag, and an instruction.',
  'Return the replacement text for that element only: plain text, no HTML, no Markdown, no quotation marks around it, no notes or explanation.',
  'Keep the meaning, facts, names, numbers and links unless the instruction asks you to change them.',
  'Keep it to one paragraph with no line breaks; the element holds a single line of text.',
  'Match the length the element suits: a heading stays heading-length, a button label stays short.',
  'Never use em dashes.',
].join(' ');

const SCHEMA = {
  type: 'object',
  properties: { replacement: { type: 'string', description: 'The new text for the element, nothing else.' } },
  required: ['replacement'],
  additionalProperties: false,
};

// The only function that talks to Anthropic. Raw HTTP on purpose: Plater has
// no dependencies, so the SDK is not available here. Returns
// { status, body } with the parsed JSON body, or throws on a network failure.
export async function callClaude({ text, tag, path: contentPath, instruction }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': KEY,
    'anthropic-version': '2026-10-21',
  };
  if (WORKSPACE) headers['anthropic-workspace-id'] = WORKSPACE;
  if (FALLBACKS) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  const user = [
    `Element: <${tag}>${contentPath ? ` (content field "${contentPath}")` : ''}`,
    'Current text:',
    text,
    '',
    `Instruction: ${instruction}`,
  ].join('\n');
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Adaptive thinking is the default on both models; low effort keeps it
    // short or skipped for a one-paragraph rewrite, which is what makes the
    // reply arrive in a few seconds.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
    ...(FALLBACKS ? { fallbacks: 'default' } : {}),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE_URL}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const out = await r.json().catch(() => ({}));
    return { status: r.status, body: out };
  } finally { clearTimeout(timer); }
}

/* ---------------- the handler ---------------- */

// Plain words for the person at the page. Upstream text is never forwarded:
// it can name the account, and the editor cannot act on it anyway.
function upstreamError(status, body) {
  const msg = String(body?.error?.message || '');
  if (status === 400 && /workspace/i.test(msg)) return [502, 'The assistant is not set up correctly on the server (its workspace is missing). Nothing was changed.'];
  if (status === 401 || status === 403) return [502, 'The assistant could not sign in to Claude. Nothing was changed.'];
  if (status === 429) return [429, 'Claude is busy right now. Try again in a minute.'];
  if (status === 529 || status === 503) return [503, 'Claude is overloaded right now. Try again shortly.'];
  return [502, 'The assistant could not write a proposal this time. Nothing was changed.'];
}

export async function respond(req, res, editor) {
  let body;
  try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
  catch { return res.status(400).json({ error: 'invalid JSON body' }); }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
  const tag = /^[a-z][a-z0-9-]{0,20}$/i.test(String(body?.tag || '')) ? String(body.tag).toLowerCase() : 'p';
  const contentPath = /^[\w.-]{1,200}$/.test(String(body?.path || '')) ? String(body.path) : '';
  if (!instruction) return res.status(400).json({ error: 'Say what should change.' });
  if (instruction.length > MAX_INSTRUCTION) return res.status(400).json({ error: `Keep the instruction under ${MAX_INSTRUCTION} characters.` });
  if (text.length > MAX_TEXT) return res.status(413).json({ error: 'This element is too long for the assistant.' });

  const over = reserve(editor);
  if (over) return res.status(429).json({ error: over === 'site' ? 'The assistant has reached today’s limit for this site.' : 'You have reached today’s limit for the assistant.' });

  let up;
  try { up = await callClaude({ text, tag, path: contentPath, instruction }); }
  catch { release(editor); return res.status(504).json({ error: 'Claude did not answer in time. Nothing was changed.' }); }

  const usage = up.body && typeof up.body.usage === 'object' && up.body.usage ? up.body.usage : null;
  // Billed means Anthropic sent a usage block. That is the line the credit is
  // charged from, written before anything else can fail.
  if (usage) recordUsage(editor, String(up.body.model || MODEL), usage);
  else release(editor);

  if (up.status !== 200) {
    const [code, message] = upstreamError(up.status, up.body);
    return res.status(code).json({ error: message });
  }
  if (up.body.stop_reason === 'refusal') return res.status(422).json({ error: 'Claude declined this one. Try different words.' });
  if (up.body.stop_reason === 'max_tokens') return res.status(422).json({ error: 'The proposal ran too long. Ask for something shorter.' });
  const out = (up.body.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  let replacement;
  try { replacement = JSON.parse(out).replacement; } catch {}
  if (typeof replacement !== 'string' || !replacement.trim()) return res.status(502).json({ error: 'The assistant could not write a proposal this time. Nothing was changed.' });
  // Bindings hold one line of plain text, exactly what a hand edit can type.
  replacement = replacement.replace(/\s*\n+\s*/g, ' ').replace(/—/g, ', ').trim();
  return res.status(200).json({ replacement });
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!KEY) return res.status(501).json({ error: 'assistant not configured' });
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const editor = await editorFor(bearer);
  if (!editor) return res.status(401).json({ error: 'Sign in to use the assistant.' });
  return respond(req, res, editor);
}
