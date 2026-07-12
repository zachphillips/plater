// elsewhere-bridge — drain plater-list captures into the LOCAL Elsewhere vault.
//
// Why pull, not push: the Elsewhere vault deliberately binds 127.0.0.1 with no
// auth (single-owner local trust). Nothing on the internet can reach it — so
// the bridge runs ON the owner's machine, polls the worker's /export cursor
// endpoint, and inserts new signups via the vault's own
// POST /api/newsletter/subscribers. Sovereignty preserved: the canonical list
// lives in the owner's vault; the worker is just the public capture point.
//
//   PLATER_LIST_URL=https://plater-list.….workers.dev \
//   PLATER_LIST_ADMIN_TOKEN=… \
//   ELSEWHERE_URL=http://127.0.0.1:8787 \
//   node elsewhere-bridge.mjs <site> [--tags plater] [--loop 300]
//
// State: cursor persisted in ~/.plater-list-bridge/<site>.json so restarts
// never re-fetch old rows. "Already on the list" (409) counts as synced.
// Wire --loop N to cron/launchd for continuous sync.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LIST_URL = (process.env.PLATER_LIST_URL || 'https://plater-list.kitchenbrigade.workers.dev').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.PLATER_LIST_ADMIN_TOKEN || '';
const ELSEWHERE = (process.env.ELSEWHERE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

const args = process.argv.slice(2);
const site = args.find((a) => !a.startsWith('--'));
const tags = args.includes('--tags') ? args[args.indexOf('--tags') + 1] : 'plater';
const loopSec = args.includes('--loop') ? Number(args[args.indexOf('--loop') + 1]) : 0;
if (!site || !ADMIN_TOKEN) {
  console.error('usage: PLATER_LIST_ADMIN_TOKEN=… node elsewhere-bridge.mjs <site> [--tags t] [--loop seconds]');
  process.exit(1);
}

const stateDir = path.join(os.homedir(), '.plater-list-bridge');
fs.mkdirSync(stateDir, { recursive: true });
const statePath = path.join(stateDir, `${site}.json`);

function readCursor() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor; } catch { return '1970-01-01T00:00:00Z'; }
}

async function syncOnce() {
  const since = readCursor();
  const r = await fetch(`${LIST_URL}/export?site=${encodeURIComponent(site)}&since=${encodeURIComponent(since)}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const out = await r.json();
  if (!r.ok || out.error) throw new Error(out.error || `export ${r.status}`);
  let synced = 0, skipped = 0;
  for (const row of out.rows) {
    if (row.unsubscribed_at) { skipped++; continue; }
    const res = await fetch(`${ELSEWHERE}/api/newsletter/subscribers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: row.email, tags }),
    });
    if (res.ok) synced++;
    else if (res.status === 409) skipped++; // already on the list — fine
    else {
      const err = await res.text().catch(() => '');
      // stop BEFORE advancing the cursor past this row so it retries next run
      throw new Error(`vault rejected ${row.email}: ${res.status} ${err.slice(0, 200)}`);
    }
  }
  fs.writeFileSync(statePath, JSON.stringify({ cursor: out.cursor, at: new Date().toISOString() }, null, 2) + '\n');
  console.log(`[${new Date().toISOString()}] ${site}: ${synced} new → vault, ${skipped} already-there/unsubscribed, cursor ${out.cursor}`);
}

async function main() {
  do {
    try { await syncOnce(); } catch (e) {
      console.error(`[${new Date().toISOString()}] sync failed (will retry): ${e.message}`);
      if (!loopSec) process.exit(1);
    }
    if (loopSec) await new Promise((r) => setTimeout(r, loopSec * 1000));
  } while (loopSec);
}
main();
