// ZMS agent host — runs on Trapjaw. Receives a captured note (element context +
// the owner's instruction + a chosen engine/output), then runs a coding agent
// against the target site's repo checkout and opens a PR (or pushes).
//
// SECURITY MODEL (public but locked down):
//   - Bearer token required on every mutating request (constant-time compare).
//   - The site -> repo/path mapping is server-side (sites.json). The client
//     never chooses an arbitrary repo; it only names an allowlisted site.
//   - PR-by-default: a note produces a pull request a human reviews, not a
//     live deploy, unless the site is explicitly configured output:"push".
//   - Rate limited + concurrency-capped + append-only audit journal.
//   - Intended to sit behind a Cloudflare Tunnel (agent.thekitchen.co).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.ZMS_AGENT_PORT || 8787);
const TOKEN = process.env.ZMS_AGENT_TOKEN || '';
const WORKDIR = process.env.ZMS_AGENT_WORKDIR || path.join(os.homedir(), 'zms-agent');
const SITES_FILE = process.env.ZMS_AGENT_SITES || path.join(WORKDIR, 'sites.json');
const JOURNAL = path.join(WORKDIR, 'jobs.jsonl');
const MAX_BODY = 3_000_000;
const JOB_TIMEOUT_MS = Number(process.env.ZMS_AGENT_TIMEOUT_MS || 8 * 60_000);
const MAX_CONCURRENT = Number(process.env.ZMS_AGENT_CONCURRENCY || 2);

// Engine command builders. Each returns [cmd, args]. Tuned per engine; the
// agent edits files in cwd, the runner handles git/PR deterministically after.
const ENGINES = {
  claude: (prompt) => ['claude', ['-p', prompt, '--permission-mode', 'acceptEdits']],
  codex: (prompt) => ['codex', ['exec', '--full-auto', prompt]],
  // Local model via codex's oss provider (qwen-coder on the 3080). Draft-quality.
  local: (prompt) => ['codex', ['exec', '--full-auto', '--oss', '-m', process.env.ZMS_LOCAL_MODEL || 'qwen2.5-coder:7b', prompt]],
};

if (!TOKEN) { console.error('FATAL: ZMS_AGENT_TOKEN is not set'); process.exit(1); }
fs.mkdirSync(WORKDIR, { recursive: true });

let SITES = {};
function loadSites() {
  try { SITES = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); }
  catch (e) { console.error('WARN: could not read sites.json:', e.message); SITES = {}; }
}
loadSites();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- simple in-memory rate limiter (per process) ---
const hits = [];
function rateOk() {
  const now = Date.now(); const windowMs = 60_000; const limit = Number(process.env.ZMS_AGENT_RATE || 20);
  while (hits.length && now - hits[0] > windowMs) hits.shift();
  if (hits.length >= limit) return false;
  hits.push(now); return true;
}

const jobs = new Map();
let running = 0;
const queue = [];

function journal(entry) {
  try { fs.appendFileSync(JOURNAL, JSON.stringify(entry) + '\n'); } catch {}
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: JOB_TIMEOUT_MS, maxBuffer: 20_000_000, ...opts },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (opts.onChild) opts.onChild(child);
  });
}

function buildPrompt(job, site) {
  const c = job.capture || {};
  return [
    `You are making a small, targeted change to the website "${job.site}" (repo ${site.repo}),`,
    `based on a note the site owner left while viewing the LIVE page. Make ONLY the change requested.`,
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
    `- Nearby text: ${(c.text || '').slice(0, 400)}`,
    `- Element HTML: ${(c.outerHTML || '').slice(0, 1500)}`,
    ``,
    `When finished, make sure the change is complete and the site still builds. Do not run git;`,
    `the surrounding tooling will commit and open a pull request.`,
  ].join('\n');
}

async function runner() {
  if (running >= MAX_CONCURRENT || !queue.length) return;
  const job = queue.shift();
  running++;
  const site = SITES[job.site];
  const update = (patch) => { Object.assign(job, patch); journal({ ...job, capture: undefined, _child: undefined, t: new Date().toISOString() }); };
  try {
    update({ status: 'running' });
    const repoPath = site.path;
    const branch = `zms/note-${job.id}`;
    const engine = ENGINES[job.route.engine] ? job.route.engine : (site.defaultEngine || 'claude');
    const output = job.route.output || site.defaultOutput || 'pr';

    // fresh branch from origin/main
    await run('git', ['-C', repoPath, 'fetch', 'origin', '--quiet']);
    await run('git', ['-C', repoPath, 'checkout', '-B', branch, 'origin/main', '--quiet']);

    // run the agent in the repo
    const [cmd, args] = ENGINES[engine](buildPrompt(job, site));
    update({ status: 'agent-running', engine, output });
    const res = await run(cmd, args, { cwd: repoPath, onChild: (ch) => { job._child = ch; } });
    job._child = null;

    // did anything change?
    const status = await run('git', ['-C', repoPath, 'status', '--porcelain']);
    if (!status.stdout.trim()) {
      update({ status: 'no-change', agentTail: res.stderr.slice(-500) || res.stdout.slice(-500) });
      return;
    }

    await run('git', ['-C', repoPath, 'add', '-A']);
    const msg = `content(${job.site}): ${(job.note || 'edit via note').slice(0, 72)}`;
    await run('git', ['-C', repoPath, '-c', 'user.name=Zach Phillips', '-c', 'user.email=zach@thekitchen.co', 'commit', '-q', '-m', msg]);

    if (output === 'push') {
      const pr = await run('git', ['-C', repoPath, 'push', 'origin', 'HEAD:main', '--quiet']);
      update({ status: pr.ok ? 'pushed' : 'push-failed', detail: pr.stderr.slice(-300) });
    } else {
      await run('git', ['-C', repoPath, 'push', '-u', 'origin', branch, '--force-with-lease', '--quiet']);
      const pr = await run('gh', ['pr', 'create', '--repo', site.repo, '--head', branch, '--title', msg, '--body',
        `Requested via ZMS note.\n\n> ${job.note || ''}\n\nElement: \`${job.capture?.selector || ''}\`\nPage: ${job.capture?.url || ''}`], { cwd: repoPath });
      const url = (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || null;
      update({ status: pr.ok ? 'pr-open' : 'pr-failed', prUrl: url, detail: pr.ok ? undefined : pr.stderr.slice(-300) });
    }
  } catch (e) {
    update({ status: 'error', detail: String(e.message || e) });
  } finally {
    running--;
    setImmediate(runner);
  }
}

function sendJson(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

async function readBody(req) {
  const chunks = []; let len = 0;
  for await (const c of req) { len += c.length; if (len > MAX_BODY) throw new Error('payload too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, sites: Object.keys(SITES), running, queued: queue.length });

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth || !safeEqual(auth, TOKEN)) return sendJson(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
    const id = url.pathname.split('/')[2];
    const j = jobs.get(id);
    return j ? sendJson(res, 200, { id, status: j.status, prUrl: j.prUrl, detail: j.detail }) : sendJson(res, 404, { error: 'no such job' });
  }

  if (req.method === 'POST' && url.pathname === '/note') {
    if (!rateOk()) return sendJson(res, 429, { error: 'rate limited' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }
    const site = body.site;
    if (!site || !SITES[site]) return sendJson(res, 400, { error: `unknown site (allowed: ${Object.keys(SITES).join(', ')})` });
    if (!body.note || typeof body.note !== 'string') return sendJson(res, 400, { error: 'note text required' });
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, ts: new Date().toISOString(), site, note: body.note.slice(0, 4000),
      capture: body.capture || {}, route: { engine: body.route?.engine, output: body.route?.output }, status: 'queued' };
    jobs.set(id, job); journal({ id, ts: job.ts, site, note: job.note, route: job.route, status: 'queued' });
    queue.push(job); setImmediate(runner);
    return sendJson(res, 202, { id, status: 'queued' });
  }

  if (req.method === 'POST' && url.pathname === '/reload') { loadSites(); return sendJson(res, 200, { ok: true, sites: Object.keys(SITES) }); }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`zms-agent-host on http://127.0.0.1:${PORT}  workdir=${WORKDIR}  sites=${Object.keys(SITES).join(',') || '(none)'}`));
