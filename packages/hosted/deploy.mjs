#!/usr/bin/env node
// node packages/hosted/deploy.mjs <config.json> [--secrets]
//
// Deploys hosted Plater (worker.js) with wrangler. Your account's ids live in a
// local config file, not in this repo:
//   { "name": "plater", "hostname": "plater.example.com", "accountId": "…",
//     "d1": "<database uuid>", "r2": "<bucket>", "accessTeam": "<team>.cloudflareaccess.com",
//     "accessAud": "<Access application AUD>", "ownerEmail": "you@example.com",
//     "allowedEmails": "" }
// The build copies the editor, the note overlay and the page chrome into a
// static-assets folder next to a generated wrangler.json, then runs
// `npx wrangler deploy`. With --secrets it also sets PUBLISH_TOKEN and
// RUNNER_TOKEN from the environment. Run schema.sql on the D1 database first.
// Cloudflare credentials come from CLOUDFLARE_API_TOKEN in the environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WRANGLER = 'wrangler@4.156.0';

const cfgPath = process.argv[2];
if (!cfgPath) { console.error('usage: node packages/hosted/deploy.mjs <config.json> [--secrets]'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
for (const k of ['hostname', 'accountId', 'd1', 'r2', 'accessTeam', 'accessAud', 'ownerEmail']) if (!cfg[k]) { console.error(`config is missing ${k}`); process.exit(1); }

const out = path.join(os.homedir(), '.cache', 'plater-hosted-deploy');
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, 'assets', to)), { recursive: true }); fs.copyFileSync(path.join(REPO, from), path.join(out, 'assets', to)); };
copy('packages/core/src/editor.js', 'packages/core/src/editor.js');
copy('packages/capture/src/capture.js', 'packages/capture/src/capture.js');
copy('packages/hosted/assets/__plater/notes.js', '__plater/notes.js');

const config = {
  name: cfg.name || 'plater',
  main: path.join(HERE, 'worker.js'),
  compatibility_date: '2025-12-01',
  account_id: cfg.accountId,
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: cfg.hostname, custom_domain: true }],
  assets: { directory: path.join(out, 'assets'), binding: 'ASSETS', run_worker_first: true },
  d1_databases: [{ binding: 'DB', database_name: cfg.d1Name || 'plater', database_id: cfg.d1 }],
  r2_buckets: [{ binding: 'BLOBS', bucket_name: cfg.r2 }],
  vars: { ACCESS_TEAM: cfg.accessTeam, ACCESS_AUD: cfg.accessAud, OWNER_EMAIL: cfg.ownerEmail, ALLOWED_EMAILS: cfg.allowedEmails || '', PUBLIC_URL: `https://${cfg.hostname}` },
  observability: { enabled: true },
};
const wranglerJson = path.join(out, 'wrangler.json');
fs.writeFileSync(wranglerJson, JSON.stringify(config, null, 2));

const wr = (args, input) => {
  const r = spawnSync('npx', ['-y', WRANGLER, ...args, '--config', wranglerJson], { stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], input, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: cfg.accountId } });
  if (r.status !== 0) process.exit(r.status || 1);
};
wr(['deploy']);
if (process.argv.includes('--secrets')) {
  for (const k of ['PUBLISH_TOKEN', 'RUNNER_TOKEN']) {
    if (!process.env[k]) { console.error(`--secrets: ${k} is not set`); process.exit(1); }
    wr(['secret', 'put', k], process.env[k]);
  }
}
