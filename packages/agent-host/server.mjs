// Plater agent host. Receives a captured note (element context +
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
//   - Intended to sit behind a Cloudflare Tunnel (agent.<your-domain>).
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
// Git identity for agent-authored commits. Set these to the site owner's own
// name/email so PRs are attributed correctly.
const GIT_NAME = process.env.PLATER_GIT_NAME || 'Plater Agent';
const GIT_EMAIL = process.env.PLATER_GIT_EMAIL || 'plater@users.noreply.github.com';

// Engine command builders. Each returns [cmd, args]. Tuned per engine; the
// agent edits files in cwd, the runner handles git/PR deterministically after.
// NOTE ON SANDBOXING: codex runs with --dangerously-bypass-approvals-and-sandbox
// because bubblewrap needs user-namespaces, which many hosts disable. This
// assumes a TRUSTED, SINGLE-TENANT box you own. Do not run this host on shared
// hardware, and keep the bearer token secret. claude uses acceptEdits.
const ENGINES = {
  claude: (prompt) => ['claude', ['-p', prompt, '--permission-mode', 'acceptEdits']],
  codex: (prompt) => ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]],
  // Local model via codex's ollama provider. Draft-only;
  // small models are unreliable at agentic file edits — prefer claude/codex.
  local: (prompt) => ['codex', ['exec', '--oss', '--local-provider=ollama', '-m', process.env.ZMS_LOCAL_MODEL || 'qwen2.5-coder:7b', '--dangerously-bypass-approvals-and-sandbox', prompt]],
};

if (!TOKEN) { console.error('FATAL: ZMS_AGENT_TOKEN is not set'); process.exit(1); }
fs.mkdirSync(WORKDIR, { recursive: true });

// Never let a git subprocess block on an interactive credential/host prompt —
// it must fail fast so a job errors instead of hanging until the job timeout.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';

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
    // Close stdin so headless agents (claude -p / codex exec) get EOF immediately
    // instead of waiting ~3s for piped input that never comes.
    try { if (child.stdin) child.stdin.end(); } catch {}
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
    // design mode, accept leg: the owner chose one of the generated concept
    // images — the depicted design IS the spec, the note is secondary.
    ...(job.designSpec ? [
      `CHOSEN DESIGN (this is the spec — match the depicted design):`,
      `The owner reviewed generated design alternatives and accepted the image at`,
      `${job.designSpec} (local file in this machine's design-jobs dir). Read/view that image and`,
      `implement the element so it matches the depicted design as closely as the site's`,
      `existing CSS system allows. The note above describes the intent behind it.`,
      ``,
    ] : []),
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

/* ---------------- design alternatives (GPT-Image via codex on this box) -----
   The image-first design loop: a design note generates N alternative concept
   IMAGES of the selected element (screenshot + note → codex image generation),
   the owner picks one in the overlay (or asks for more), and only THEN does a
   coding agent implement it — with the chosen image as the spec. Images are
   served back through /design/:jobId/:n.png (bearer-gated like every route).

   Screenshot is taken HERE, server-side, with Playwright against the PUBLIC
   page URL — the browser overlay never needs screen-capture permissions and
   the README's long-promised `screenshot` capture field is finally real. */
const DESIGN_DIR = path.join(WORKDIR, 'design-jobs');
fs.mkdirSync(DESIGN_DIR, { recursive: true });
const DESIGN_COUNT = Number(process.env.ZMS_DESIGN_COUNT || 3);

async function screenshotElement(jobDir, pageUrl, selector) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 45_000 });
    const shot = path.join(jobDir, 'context.png');
    // full-viewport shot (the design needs surrounding context), plus the
    // element's bounding box recorded so prompts can point at the region
    await page.screenshot({ path: shot });
    let box = null;
    if (selector) {
      try { box = await page.locator(selector).first().boundingBox({ timeout: 5_000 }); } catch {}
    }
    return { shot, box };
  } finally {
    await browser.close();
  }
}

function designPrompt(job, n, box) {
  const c = job.capture || {};
  return [
    `You are exploring VISUAL DESIGN ALTERNATIVES for one element of a live website.`,
    `The file context.png in the current directory is a screenshot of the page ${c.url || ''}.`,
    box ? `The element being redesigned is at approximately x=${Math.round(box.x)}, y=${Math.round(box.y)}, ${Math.round(box.width)}x${Math.round(box.height)}px in that screenshot.` : '',
    c.selector ? `Its CSS selector is ${c.selector}.` : '',
    ``,
    `OWNER'S DESIGN NOTE: ${job.note}`,
    ``,
    `Generate ONE image: concept ${n} of ${DESIGN_COUNT} — a distinct redesign of that element`,
    `honoring the note, rendered IN PLACE in the page (show the element in its surrounding`,
    `context so the owner can judge fit). Keep the site's overall identity unless the note`,
    `says otherwise. Concept ${n} should take a genuinely different direction than the others.`,
    `No browser chrome, no lorem ipsum walls. One single image, never a grid or composite.`,
    `Save it to exactly alt-${n}.png in the current directory.`,
  ].filter(Boolean).join('\n');
}

async function runDesignJob(job, update) {
  const jobDir = path.join(DESIGN_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  update({ status: 'screenshotting' });
  const c = job.capture || {};
  if (!c.url) { update({ status: 'error', detail: 'design job needs capture.url' }); return; }
  const { box } = await screenshotElement(jobDir, c.url, c.selector);
  update({ status: 'generating', detail: `${DESIGN_COUNT} alternatives via codex image-gen` });
  // sequential: each concept sees which numbers exist, and the box is small
  const made = [];
  for (let n = 1; n <= DESIGN_COUNT; n++) {
    const res = await run('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', designPrompt(job, n, box)], { cwd: jobDir });
    if (fs.existsSync(path.join(jobDir, `alt-${n}.png`))) made.push(n);
    else journal({ id: job.id, status: 'alt-failed', n, tail: (res.stderr || res.stdout).slice(-300) });
  }
  if (!made.length) { update({ status: 'error', detail: 'no alternatives generated' }); return; }
  update({ status: 'alternatives-ready', alternatives: made.map((n) => `/design/${job.id}/alt-${n}.png`) });
}

async function runner() {
  if (running >= MAX_CONCURRENT || !queue.length) return;
  const job = queue.shift();
  running++;
  const site = SITES[job.site];
  const update = (patch) => { Object.assign(job, patch); journal({ ...job, capture: undefined, _child: undefined, t: new Date().toISOString() }); };
  try {
    update({ status: 'running' });
    if (job.kind === 'design') { await runDesignJob(job, update); return; }
    const repoPath = site.path;
    const branch = `zms/note-${job.id}`;
    const engine = ENGINES[job.route.engine] ? job.route.engine : (site.defaultEngine || 'claude');
    const output = job.route.output || site.defaultOutput || 'pr';

    // fresh branch from the site's base branch (default main)
    const base = site.branch || 'main';
    await run('git', ['-C', repoPath, 'fetch', 'origin', '--quiet']);
    await run('git', ['-C', repoPath, 'checkout', '-B', branch, `origin/${base}`, '--quiet']);

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
    await run('git', ['-C', repoPath, '-c', `user.name=${GIT_NAME}`, '-c', `user.email=${GIT_EMAIL}`, 'commit', '-q', '-m', msg]);

    if (output === 'push') {
      const pr = await run('git', ['-C', repoPath, 'push', 'origin', `HEAD:${base}`, '--quiet']);
      update({ status: pr.ok ? 'pushed' : 'push-failed', detail: pr.stderr.slice(-300) });
    } else {
      await run('git', ['-C', repoPath, 'push', '-u', 'origin', branch, '--force-with-lease', '--quiet']);
      const pr = await run('gh', ['pr', 'create', '--repo', site.repo, '--head', branch, '--title', msg, '--body',
        `Requested via Plater note.\n\n> ${job.note || ''}\n\nElement: \`${job.capture?.selector || ''}\`\nPage: ${job.capture?.url || ''}`], { cwd: repoPath });
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
    return j ? sendJson(res, 200, { id, status: j.status, prUrl: j.prUrl, detail: j.detail, alternatives: j.alternatives }) : sendJson(res, 404, { error: 'no such job' });
  }

  // design alternative image: GET /design/:jobId/alt-N.png (bearer-gated above)
  if (req.method === 'GET' && url.pathname.startsWith('/design/')) {
    const [, , jobId, file] = url.pathname.split('/');
    if (!/^[a-f0-9]+$/.test(jobId || '') || !/^alt-\d+\.png$/.test(file || '')) return sendJson(res, 400, { error: 'bad path' });
    const p = path.join(DESIGN_DIR, jobId, file);
    if (!fs.existsSync(p)) return sendJson(res, 404, { error: 'no such image' });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
    fs.createReadStream(p).pipe(res);
    return;
  }

  // POST /design — generate N design-alternative images for a captured element.
  // Same body as /note; produces images, not code. The owner then either asks
  // for more (another /design with a refined note) or accepts one via /accept.
  if (req.method === 'POST' && url.pathname === '/design') {
    if (!rateOk()) return sendJson(res, 429, { error: 'rate limited' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }
    if (!body.site || !SITES[body.site]) return sendJson(res, 400, { error: `unknown site (allowed: ${Object.keys(SITES).join(', ')})` });
    if (!body.note || typeof body.note !== 'string') return sendJson(res, 400, { error: 'design note text required' });
    if (!body.capture?.url) return sendJson(res, 400, { error: 'capture.url required (the live page to screenshot)' });
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, kind: 'design', ts: new Date().toISOString(), site: body.site, note: body.note.slice(0, 4000),
      capture: body.capture, status: 'queued' };
    jobs.set(id, job); journal({ id, ts: job.ts, kind: 'design', site: job.site, note: job.note, status: 'queued' });
    queue.push(job); setImmediate(runner);
    return sendJson(res, 202, { id, status: 'queued' });
  }

  // POST /accept — the owner picked alternative N of a design job: run the
  // normal code path with the chosen image as the spec ("match this depicted
  // design"). Body: { designJob: "<id>", alternative: N, note?, route? }
  if (req.method === 'POST' && url.pathname === '/accept') {
    if (!rateOk()) return sendJson(res, 429, { error: 'rate limited' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }
    const src = jobs.get(String(body.designJob || ''));
    if (!src || src.kind !== 'design') return sendJson(res, 404, { error: 'no such design job' });
    const alt = Number(body.alternative);
    const img = path.join(DESIGN_DIR, src.id, `alt-${alt}.png`);
    if (!Number.isInteger(alt) || !fs.existsSync(img)) return sendJson(res, 400, { error: 'no such alternative' });
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, ts: new Date().toISOString(), site: src.site,
      note: (body.note || src.note).slice(0, 4000), capture: src.capture,
      designSpec: img,
      route: { engine: body.route?.engine, output: body.route?.output }, status: 'queued' };
    jobs.set(id, job); journal({ id, ts: job.ts, site: job.site, note: job.note, designSpec: img, route: job.route, status: 'queued' });
    queue.push(job); setImmediate(runner);
    return sendJson(res, 202, { id, status: 'queued', from: src.id, alternative: alt });
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
