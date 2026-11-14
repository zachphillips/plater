#!/usr/bin/env node
// Hosted Plater note runner. Runs on the owner's always-on machine, next to the
// owner's ChatGPT plan sign-in (agent-host/chatgpt.mjs; move it there with
// `chatgpt.mjs move-to <host>`). It claims one queued ✎ Note at a time from the
// hosted Worker, rebuilds that version's files in a scratch folder, runs one
// Codex turn there on the owner's plan (runPlanNote: same speed settings, same
// isolated CODEX_HOME), and posts the changed files back. The Worker turns them
// into the next version, and the open tab reloads.
//
// Only the owner's own notes run on the owner's plan: a note from any other
// signed-in person is refused here, whatever the Worker allows.
//
// Env (or ~/.config/plater/hosted.env): PLATER_HOSTED_URL, PLATER_RUNNER_TOKEN,
// PLATER_OWNER_EMAIL, PLATER_CHATGPT_PLAN=1. Optional PLATER_RUNNER_POLL_MS (5000).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planGate, runPlanNote } from '../agent-host/chatgpt-plan.mjs';
import { notePrompt } from '../agent-host/dev-notes.mjs';

const SKIP = new Set(['.git', 'node_modules', '.codex']);

export function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const abs = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out[r] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

export function createRunner({ url, token, owner, env = process.env, run = runPlanNote, fetch: fetchImpl = fetch, log = console.log, workRoot = os.tmpdir() }) {
  const base = url.replace(/\/$/, '');
  const call = async (p, init = {}) => {
    const r = await fetchImpl(base + p, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r;
  };
  const post = async (p, body) => (await call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  async function once() {
    const { job } = await post('/_hosted/runner/next', {});
    if (!job) return false;
    const finish = (body) => post('/_hosted/runner/complete', { id: job.id, ...body });
    if (String(job.email || '').toLowerCase() !== String(owner).toLowerCase()) {
      await finish({ ok: false, detail: 'only the owner\'s notes run on the owner\'s ChatGPT plan' });
      log(`refused note ${job.id} from ${job.email}`);
      return true;
    }
    const gate = planGate({ planUsage: true }, { env });
    if (!gate.ok) { await finish({ ok: false, detail: gate.reason }); log(`note ${job.id}: ${gate.reason}`); return true; }
    const dir = fs.mkdtempSync(path.join(workRoot, `plater-note-${job.id}-`));
    try {
      for (const [rel, sha] of Object.entries(job.files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(await (await call(`/_hosted/blob/${sha}`)).arrayBuffer()));
      }
      const before = snapshot(dir);
      log(`note ${job.id} on ${job.project} v${job.version}: running`);
      const out = await run({ prompt: notePrompt({ note: job.note, capture: job.capture }, job.title || job.project), cwd: dir, env });
      if (!out.ok) { await finish({ ok: false, detail: out.detail || out.status }); log(`note ${job.id}: ${out.status}`); return true; }
      const after = snapshot(dir);
      const files = {};
      for (const [rel, sha] of Object.entries(after)) {
        if (before[rel] === sha) continue;
        await call(`/_hosted/blob/${sha}`, { method: 'PUT', body: fs.readFileSync(path.join(dir, rel)) });
        files[rel] = sha;
      }
      const deleted = Object.keys(before).filter((rel) => !(rel in after));
      const res = await post('/_hosted/runner/complete', { id: job.id, ok: true, files, deleted, detail: out.tierNote || undefined });
      log(`note ${job.id}: ${Object.keys(files).length} changed, ${deleted.length} removed${res.version ? ` → v${res.version}` : ''}`);
    } catch (e) {
      await finish({ ok: false, detail: String(e.message || e).slice(0, 400) }).catch(() => {});
      log(`note ${job.id} failed: ${e.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return true;
  }

  async function loop({ pollMs = 5000, signal } = {}) {
    let backoff = pollMs;
    while (!signal?.aborted) {
      try { const worked = await once(); backoff = pollMs; if (worked) continue; }
      catch (e) { log(`runner: ${e.message}`); backoff = Math.min(backoff * 2, 120_000); }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return { once, loop };
}

function loadEnvFile(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  loadEnvFile(path.join(os.homedir(), '.config', 'plater', 'hosted.env'));
  const { PLATER_HOSTED_URL: url = 'https://plater.thekitchen.co', PLATER_RUNNER_TOKEN: token, PLATER_OWNER_EMAIL: owner } = process.env;
  if (!token || !owner) { console.error('set PLATER_RUNNER_TOKEN and PLATER_OWNER_EMAIL (or ~/.config/plater/hosted.env)'); process.exit(1); }
  console.log(`plater note runner → ${url} (owner ${owner})`);
  createRunner({ url, token, owner }).loop({ pollMs: Number(process.env.PLATER_RUNNER_POLL_MS || 5000) });
}
