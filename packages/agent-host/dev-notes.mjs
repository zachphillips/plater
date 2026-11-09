// In-place notes for `plater dev` drafts, run on the owner's ChatGPT plan.
//
// A draft an agent built (a site, a deck, a proposal) is served by
// `plater dev <dir>` on 127.0.0.1. With this switched on, every page gets the
// ✎ Note overlay (@platercms/capture). A note runs one Codex turn IN the draft's
// folder on the owner's plan (chatgpt-plan.mjs). Live reload then shows the
// change in the open tab. No branch, no push, no PR: dev saves are plain file
// writes, and so are these. Commit when happy, same as any dev edit.
//
// ON only when the dev process has PLATER_CHATGPT_PLAN=1 AND the owner signed in
// on this machine with plan usage granted (planGate). Without both, dev keeps its
// old behavior: notes echo and nothing runs.
//
// plater dev has no auth, so the note endpoint takes requests only from this
// machine's own pages: loopback peer, a loopback Host (no DNS rebinding), a
// same-origin Origin when one is sent, and a JSON content type (which forces a
// CORS preflight dev never answers, so a cross-site form post cannot reach it).
// Single-file mode (`plater dev ~/Downloads/x.html`) never runs notes: the folder
// around a loose file is not a draft, and the agent would get write access to it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planGate, planDir, runPlanNote } from './chatgpt-plan.mjs';

const CAPTURE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'capture', 'src', 'capture.js');
const LOOPBACK_PEER = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export const BOOT_JS = `import { initCapture } from '/__plater/capture.js';
// A page that already runs its own capture keeps it (its notes reach the same
// endpoint); a second overlay would put two ✎ Note buttons in the bar.
const start = () => document.querySelector('.zmscap-launch') || initCapture({ apiBase: '/api', brand: 'Plater',
  engines: [{ id: 'chatgpt', label: 'ChatGPT' }], outputs: [{ id: 'local', label: 'Apply here' }],
  defaults: { engine: 'chatgpt', output: 'local' } });
const wait = (n) => (document.getElementById('cms-bar') || n <= 0) ? start() : setTimeout(() => wait(n - 1), 100);
document.readyState === 'loading' ? addEventListener('DOMContentLoaded', () => wait(15)) : wait(15);
`;

export function injectNotesClient(html) {
  if (html.includes('/__plater/notes.js')) return html;
  const tag = '<script type="module" src="/__plater/notes.js"></script>';
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

// Exported for the guard test: is this request from one of this machine's own pages?
export function sameMachine(req) {
  const peer = req.socket?.remoteAddress || '';
  if (!LOOPBACK_PEER.has(peer)) return false;
  const host = String(req.headers.host || '');
  if (!LOOPBACK_HOST.test(host)) return false;
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  return true;
}

function notePrompt(job, label) {
  const c = job.capture || {};
  return [
    `You are making a small, targeted change to the draft "${label}" in the current directory,`,
    `based on a note its owner left while viewing the page. Make ONLY the change requested.`,
    `Keep the existing visual style and structure. Do not refactor unrelated code. If the change is`,
    `copy/content and a bound content path is given, prefer editing the content JSON at that path.`,
    ``,
    `NOTE FROM OWNER:`,
    job.note || '(no note text)',
    ``,
    `ELEMENT CONTEXT:`,
    `- Page URL: ${c.url || '(unknown)'}`,
    `- CSS selector: ${c.selector || '(none)'}`,
    `- Bound content path: ${c.contentPath || '(none)'}`,
    `- Nearby text: ${String(c.text || '').slice(0, 400)}`,
    `- Element HTML: ${String(c.outerHTML || '').slice(0, 1500)}`,
    ``,
    `Edit the files in place; the owner's open tab reloads on its own. Do not run git, and do not`,
    `start servers.`,
  ].join('\n');
}

// Returns null when off (dev keeps its echo), else the dev-server hooks.
export function createDevNotes({ siteDir, entry, env = process.env, run = runPlanNote }) {
  if (entry) return null;
  const dir = planDir(env);
  const gate = planGate({ planUsage: true }, { env, dir });
  if (!gate.ok) return { enabled: false, reason: gate.reason };
  const jobs = new Map(); const queue = []; let busy = false;
  const label = path.basename(siteDir);

  async function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    try {
      job.status = 'running';
      const out = await run({ prompt: notePrompt(job, label), cwd: siteDir, dir, env });
      job.status = out.ok ? 'done' : 'failed';
      job.detail = out.ok ? (out.tierNote || undefined) : String(out.detail || out.status || '').slice(-400);
    } catch (e) {
      job.status = 'failed'; job.detail = String(e.message || e).slice(-400);
    } finally { busy = false; setImmediate(pump); }
  }

  return {
    enabled: true,
    async serveAsset(p, res) {
      if (p === '/__plater/notes.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); res.end(BOOT_JS); return true; }
      if (p === '/__plater/capture.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); res.end(fs.readFileSync(CAPTURE_SRC)); return true; }
      return false;
    },
    // Body is the parsed JSON; req for the same-machine check.
    handle(req, body) {
      if (!sameMachine(req)) return [403, { error: 'notes run only from this machine\'s own pages' }];
      if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { error: 'expected an object' }];
      if (body.action === 'status') {
        const j = jobs.get(String(body.job || ''));
        return j ? [200, { id: j.id, status: j.status, detail: j.detail }] : [404, { error: 'no such job' }];
      }
      if (body.action && body.action !== 'note') return [400, { error: `${body.action} is not available on drafts` }];
      if (typeof body.note !== 'string' || !body.note.trim()) return [400, { error: 'note text required' }];
      const id = crypto.randomBytes(6).toString('hex');
      const job = { id, note: body.note.slice(0, 4000), capture: body.capture && typeof body.capture === 'object' ? body.capture : {}, status: 'queued' };
      jobs.set(id, job); queue.push(job); setImmediate(pump);
      return [202, { id, status: 'queued' }];
    },
  };
}
