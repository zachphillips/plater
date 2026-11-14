// Drive the actual Worker under `wrangler dev --local`. Only local D1, KV and
// simulated send_email are used. Faults wrap bindings, never capture logic.
// WRANGLER_BIN may point at an existing installation (no package dependency).
// LIST_PROOF_DIR selects the scratch directory containing logs and local data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.LIST_PROOF_DIR || path.join(root, '.list-proof'));
const port = Number(process.env.LIST_PROOF_PORT || 24141);
const base = `http://127.0.0.1:${port}`;
const hash = (text) => createHash('sha256').update(text || '').digest('hex');
const wrangler = process.env.WRANGLER_BIN;
if (!wrangler || !fs.existsSync(wrangler)) throw Error('Set WRANGLER_BIN to wrangler/bin/wrangler.js');
fs.mkdirSync(dir, { recursive: true });
const config = path.join(dir, 'wrangler.json');
fs.writeFileSync(config, JSON.stringify({
  name: 'plater-list-local-proof', main: path.join(root, 'verify/list-entry.js'), compatibility_date: '2026-06-01',
  vars: { SITES: `demo=https://demo.example,demo=${base},thekitchen=https://thekitchen.thekitchen.co`, RELAY_FROM: 'list@list.example.com', RELAY_TO: 'owner@example.com', LIST_ADMIN_TOKEN: 'local-proof-only' },
  d1_databases: [{ binding: 'DB', database_name: 'local-proof', database_id: '00000000-0000-0000-0000-000000000001' }],
  kv_namespaces: [{ binding: 'GAPS', id: '00000000000000000000000000000001' }, { binding: 'BENCH', id: '00000000000000000000000000000002' }],
  send_email: [{ name: 'RELAY', destination_address: 'owner@example.com' }], triggers: { crons: ['41 * * * *'] },
}, null, 2));

let child;
async function until(fn, why, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw Error(`Timed out: ${why}. See ${path.join(dir, 'worker.log')}`);
}
async function start() {
  const fd = fs.openSync(path.join(dir, 'worker.log'), 'a');
  child = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', path.join(dir, 'state'), '--port', String(port), '--inspector-port', String(port + 1), '--test-scheduled'], {
    detached: true, stdio: ['ignore', fd, fd], cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  fs.closeSync(fd);
  fs.writeFileSync(path.join(dir, 'worker.pid'), String(child.pid));
  await until(async () => (await fetch(base + '/health')).ok, 'local Wrangler ready');
}
async function stop() {
  if (!child) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  process.kill(-child.pid, 'SIGKILL');
  await exited;
  child = null;
  fs.rmSync(path.join(dir, 'worker.pid'), { force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await stop();
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
});
const state = async () => (await fetch(base + '/__bench/state')).json();
const faults = async (body) => fetch(base + '/__bench/faults', { method: 'POST', body: JSON.stringify(body) });
const post = async (id, note = null, extra = {}) => {
  const body = { site: 'demo', email: `${id}@example.com`, ...(note === null ? {} : { note }), ...extra };
  const started = Date.now();
  const r = await fetch(base + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example', 'x-bench-id': id }, body: JSON.stringify(body) });
  const text = await r.text();
  let response; try { response = JSON.parse(text); } catch { response = text; }
  return { id, submittedNoteHash: hash(body.note), submittedCharacters: [...(typeof body.note === 'string' ? body.note : '')].length, status: r.status, response, cors: r.headers.get('access-control-allow-origin'), ms: Date.now() - started };
};
const mailText = (raw) => Buffer.from(raw.split('\r\n\r\n')[1] || '', 'base64').toString('utf8');
const results = [];
async function check(id, request, verify) {
  const response = await request();
  const snapshot = await state();
  const row = snapshot.rows.find((x) => x.email === `${id}@example.com`);
  const mail = snapshot.events.filter((x) => x.value.event === 'relay_sent' && x.value.requestId === id).map((x) => mailText(x.value.raw));
  const gaps = snapshot.gaps.filter((x) => x.value.sub?.email === `${id}@example.com`);
  const failures = verify({ ...response, row, mail, gaps });
  const result = { ...response, row: row ? { noteLength: row.note?.length || 0, noteHash: hash(row.note), noteTail: row.note?.slice(-100) } : null, mailCopies: mail.length, gapMissing: gaps.map((x) => x.value.missing), failures };
  results.push(result);
  console.log(JSON.stringify(result));
}
const accepted = (r) => r.status === 200 && r.response.ok && r.cors === 'https://demo.example';
const expect = (pairs) => pairs.filter(([, ok]) => !ok).map(([why]) => why);

try {
  await start();
  await faults({});
  await fetch(base + '/__bench/seed-legacy', { method: 'POST' });
  await check('signup', () => post('signup'), (r) => expect([['honest acceptance', accepted(r)], ['D1 row', !!r.row], ['local mail', r.mail.length === 1], ['no outstanding gap', !r.gaps.length]]));
  const long = 'x'.repeat(49_999) + 'Z';
  await check('long', () => post('long', long), (r) => expect([['50,000 chars accepted', accepted(r)], ['whole D1 note', r.row?.note === long], ['whole MIME body', r.mail[0]?.includes(long)]]));
  const unusual = 'é漢字🙂<&>"\\\n\u0000'.repeat(700);
  await check('unicode', () => post('unicode', unusual), (r) => expect([['unusual text accepted', accepted(r)], ['D1 bytes preserved', r.row?.note === unusual], ['mail bytes preserved', r.mail[0]?.includes(unusual)]]));
  const emoji = '🙂'.repeat(50_000);
  await check('emoji-limit', () => post('emoji-limit', emoji), (r) => expect([['50,000 Unicode characters accepted', accepted(r)], ['whole emoji note', r.row?.note === emoji], ['whole emoji mail', r.mail[0]?.includes(emoji)]]));
  await check('too-long', () => post('too-long', 'x'.repeat(50_001)), (r) => expect([['explicit 413', r.status === 413 && typeof r.response.error === 'string'], ['nothing partially stored', !r.row && !r.mail.length && !r.gaps.length], ['readable by visitor', r.cors === 'https://demo.example']]));
  await check('repeat', () => post('repeat', 'Long earlier message includes a second message'), (r) => expect([['first inquiry', accepted(r) && r.row?.note.includes('Long earlier')]]));
  await check('repeat', () => post('repeat', 'a second message'), (r) => expect([['different shorter inquiry retained', accepted(r) && r.row?.note.endsWith('] a second message')]]));
  await check('repeat', () => post('repeat', 'a second message'), (r) => expect([['same note stored once', r.row?.note.split('] a second message').length === 2]]));
  for (const [id, fault] of [['db-down', { dbFail: true }], ['mail-down', { relayFail: true }], ['both-down', { dbFail: true, relayFail: true }]]) {
    await faults(fault);
    await check(id, () => post(id, `Full inquiry for ${id}`), (r) => expect([
      ['truthful response', fault.dbFail && fault.relayFail ? r.status === 503 && !!r.response.error : accepted(r)],
      ['repair record', r.gaps.length === 1], ['DB outcome', Boolean(r.row) === !fault.dbFail], ['mail outcome', Boolean(r.mail.length) === !fault.relayFail],
    ]));
  }
  await faults({});
  await fetch(base + '/__scheduled?cron=41+*+*+*+*');
  await until(async () => (await state()).gaps.length === 0, 'gap repair');
  const repaired = await state();
  results.push({ id: 'repair', failures: expect([['all outage inquiries in D1', ['db-down', 'mail-down', 'both-down'].every((id) => repaired.rows.some((r) => r.email === `${id}@example.com`))], ['all outage inquiries in mail', ['db-down', 'mail-down', 'both-down'].every((id) => repaired.events.some((e) => e.value.event === 'relay_sent' && mailText(e.value.raw).includes(`Full inquiry for ${id}`)))]]) });
  await faults({ dbDelayMs: 12000 });
  await check('slow-db', () => post('slow-db', 'Do not wait forever for D1'), (r) => expect([['accepted before the delayed D1 returns', accepted(r) && r.ms < 11000], ['mail has inquiry', r.mail[0]?.includes('Do not wait forever for D1')]]));
  await faults({ relayDelayMs: 12000 });
  await check('slow-mail', () => post('slow-mail', 'Do not wait forever for mail'), (r) => expect([['accepted before the delayed mail returns', accepted(r) && r.ms < 11000], ['D1 has inquiry', !!r.row], ['unfinished mail repairable', r.mail.length > 0 || r.gaps.length > 0]]));
  for (const [id, fault, event] of [['restart-after-db', { relayDelayMs: 30000 }, 'db_saved'], ['restart-before-db', { dbDelayMs: 30000 }, 'db_started']]) {
    await faults(fault);
    const inFlight = post(id, `Preserve ${id}`).catch((e) => ({ status: 'connection interrupted', error: e.message }));
    await until(async () => (await state()).events.some((e) => e.value.requestId === id && e.value.event === event), `request reached ${event}`);
    await stop();
    const response = await inFlight;
    await start();
    const before = await state();
    await faults({});
    await fetch(base + '/__scheduled?cron=41+*+*+*+*');
    await until(async () => !(await state()).gaps.some((g) => g.value.sub.email === `${id}@example.com`), 'restart repair');
    const after = await state();
    const gotDb = after.rows.some((r) => r.email === `${id}@example.com` && r.note.includes(`Preserve ${id}`));
    const gotMail = after.events.some((e) => e.value.event === 'relay_sent' && mailText(e.value.raw).includes(`Preserve ${id}`));
    results.push({ id, response, beforeRepair: { db: before.rows.some((r) => r.email === `${id}@example.com`), gap: before.gaps.some((g) => g.value.sub.email === `${id}@example.com`) }, afterRepair: { db: gotDb, mail: gotMail }, failures: expect([['restart kept submission repairable', gotDb && gotMail]]) });
  }
  await check('legacy', () => post('legacy', 'A later inquiry'), (r) => expect([['legacy note and date preserved', r.row?.note.startsWith('Existing inquiry to retain') && r.row?.note.endsWith('] A later inquiry') && r.row?.created_at === '2026-01-01T00:00:00.000Z']]));
  const concurrent = await Promise.all([post('concurrent', 'First separate message'), post('concurrent', 'Second separate message'), post('concurrent', 'First separate message')]);
  const concurrentState = await state();
  const concurrentNote = concurrentState.rows.find((r) => r.email === 'concurrent@example.com')?.note || '';
  results.push({ id: 'concurrent', responses: concurrent, storedNote: concurrentNote, failures: expect([['concurrent distinct notes kept once', concurrent.every(accepted) && concurrentNote.split('First separate message').length === 2 && concurrentNote.split('Second separate message').length === 2]]) });
  for (const [id, fault] of [['db-ack-lost', { dbFailAfterCommit: true }], ['journal-and-mail-down', { gapsFail: true, relayFail: true }], ['all-down', { gapsFail: true, relayFail: true, dbFail: true }], ['journal-only-down', { gapsFail: true }]]) {
    await faults(fault);
    await check(id, () => post(id, `Keep ${id}`), (r) => expect([['truthful degraded response', fault.gapsFail && fault.relayFail ? r.status === 503 && !!r.response.error : accepted(r)], ['available copy kept', fault.dbFail ? !r.row : !!r.row]]));
  }
  await faults({});
  await fetch(base + '/__scheduled?cron=41+*+*+*+*');
  await until(async () => (await state()).gaps.length === 0, 'final repair');
  const final = await state();
  results.push({ id: 'replayed-commit', failures: expect([['lost acknowledgement never duplicates note', final.rows.find((r) => r.email === 'db-ack-lost@example.com')?.note === 'Keep db-ack-lost']]) });
  for (const [id, raw] of [['malformed-json', '{'], ['non-text-note', JSON.stringify({ site: 'demo', email: 'invalid@example.com', note: { text: 'Do not coerce away this message' } })]]) {
    const r = await fetch(base + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example' }, body: raw });
    results.push({ id, status: r.status, response: await r.json(), failures: expect([['explicit malformed-input error', r.status === 400]]) });
  }
  const payload = new TextEncoder().encode(JSON.stringify({ site: 'demo', email: 'chunked@example.com', note: '', unused: '漢'.repeat(100000) }));
  const chunked = await fetch(base + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example' }, duplex: 'half', body: new ReadableStream({ start(controller) { for (let i = 0; i < payload.length; i += 8192) controller.enqueue(payload.slice(i, i + 8192)); controller.close(); } }) });
  results.push({ id: 'chunked-body-limit', bytes: payload.byteLength, status: chunked.status, response: await chunked.json(), failures: expect([['actual byte cap without Content-Length', chunked.status === 413]]) });
} finally {
  await stop();
  const report = { localOnly: true, results, failures: results.flatMap((r) => r.failures.map((f) => `${r.id}: ${f}`)) };
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(dir, 'results.json'), failures: report.failures }));
  if (report.failures.length && !process.env.LIST_EXPECT_FAILURE) process.exitCode = 1;
}
