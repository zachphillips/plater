// plater deploy-amber [siteDir] — ship a Plater site to Amber (forever hosting).
//
// The Plater↔Amber seam is one ZIP and one domain: zip the site's web root →
// create-site (first run) → presigned PUT → process → publish. Optional — most
// Plater sites deploy via Vercel/Cloudflare Pages instead. Kept intentionally
// tiny and dependency-free.
//
// Env:
//   AMBER_API_URL   Amber API base (e.g. https://api.amber.video)
//   AMBER_API_KEY   the owner's amber_sk_… agent key (Bearer)
//
// State: .plater-amber.json in the site dir records { siteId, slug, url } on
// first deploy, so later runs re-deploy the SAME site (rollback stays intact
// on Amber's side — re-publishing an older deployment is instant rollback).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';

const API_URL = (process.env.AMBER_API_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.AMBER_API_KEY || '';
const STATE_FILE = '.plater-amber.json';

const argDir = process.argv[2] === 'deploy-amber' ? process.argv[3] : process.argv[2];
const siteDir = path.resolve(argDir || '.');

function findWebRoot(dir) {
  for (const w of ['web', 'public', '.']) {
    if (fs.existsSync(path.join(dir, w, 'index.html'))) return path.join(dir, w);
  }
  throw new Error(`no web root with an index.html under ${dir} (looked in web/, public/, .)`);
}

async function api(method, p, body) {
  const r = await fetch(API_URL + p, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

function zipDir(dir) {
  return new Promise(async (resolve, reject) => {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'plater-amber-'));
    const zip = path.join(work, 'site.zip');
    const child = spawn('zip', ['-qr', zip, '.'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(zip) : reject(new Error('zip failed: ' + err.slice(0, 200)))));
  });
}

async function main() {
  if (!API_URL || !API_KEY) throw new Error('set AMBER_API_URL and AMBER_API_KEY (the owner\'s amber_sk_… key)');
  const webRoot = findWebRoot(siteDir);
  const statePath = path.join(siteDir, STATE_FILE);
  let state = {};
  try { state = JSON.parse(await fsp.readFile(statePath, 'utf8')); } catch {}

  const zip = await zipDir(webRoot);
  try {
    let siteId = state.siteId;
    if (!siteId) {
      const name = path.basename(siteDir);
      const site = await api('POST', '/api/static-sites', { name });
      siteId = String(site.siteId ?? site.id);
      state = { siteId, slug: site.slug, url: site.url };
      await fsp.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
      console.log(`✓ created Amber site ${state.slug || siteId}${state.url ? ' → ' + state.url : ''}`);
    }

    const upload = await api('POST', `/api/static-sites/${encodeURIComponent(siteId)}/upload-url`);
    const deploymentId = String(upload.deploymentId ?? upload.id ?? '');
    const uploadUrl = String(upload.uploadUrl ?? '');
    if (!deploymentId || !uploadUrl) throw new Error('upload-url response missing deploymentId/uploadUrl');

    const bytes = await fsp.readFile(zip);
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: bytes });
    if (!put.ok) throw new Error(`zip PUT → ${put.status}`);
    console.log(`✓ uploaded ${(bytes.length / 1024).toFixed(0)} KB`);

    await api('POST', `/api/static-sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}/process`);

    // poll until the deployment is ready (or failed)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const site = await api('GET', `/api/static-sites/${encodeURIComponent(siteId)}`);
      const all = [site.activeDeployment, ...(Array.isArray(site.deployments) ? site.deployments : []), ...(Array.isArray(site.recentDeployments) ? site.recentDeployments : [])].filter(Boolean);
      const dep = all.find((d) => d.id === deploymentId) || {};
      const status = String(dep.status || '').toLowerCase();
      if (/fail|error/.test(status)) throw new Error(`deployment failed: ${dep.error || status}`);
      if (/ready|processed|complete|succeed/.test(status)) break;
      if (i === 59) throw new Error('deployment did not become ready in 3 minutes');
    }

    await api('POST', `/api/static-sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}/publish`);
    const site = await api('GET', `/api/static-sites/${encodeURIComponent(siteId)}`);
    const live = site.url || state.url || (state.slug ? `https://${state.slug}.amber.video` : '(check Amber dashboard)');
    console.log(`✓ published — live at ${live}`);
  } finally {
    await fsp.rm(path.dirname(zip), { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
