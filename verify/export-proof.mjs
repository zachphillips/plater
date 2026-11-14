// Local D1 export journey. The real scheduled repair inserts a delayed held
// inquiry after the pull consumer has already advanced its cursor.
export async function journey({ page, step, expect, note }) {
  const base = process.env.EXPORT_PROOF_URL || 'http://127.0.0.1:24301';
  const weak = Boolean(process.env.EXPORT_EXPECT_WEAK);
  const auth = { authorization: 'Bearer local-proof-only' };
  const pull = async (cursor = '') => {
    const r = await fetch(`${base}/export?site=demo&since=${encodeURIComponent(cursor)}`, { headers: auth });
    const body = await r.json(); expect(r.ok, 'export accepted a valid cursor'); return body;
  };
  const display = async (name, detail) => {
    note(name, detail);
    await page.locator('#results').evaluate((el, x) => { el.textContent += x + '\n'; }, name + ': ' + JSON.stringify(detail, null, 2));
    await step(name);
  };
  const seeded = await (await fetch(base + '/__bench/seed-export', { method: 'POST' })).json();
  expect(seeded.seeded === 501, 'local legacy D1 has 501 equal-timestamp rows');
  const seen = new Set();
  const pages = [];
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const out = await pull(cursor);
    pages.push({ count: out.rows.length, cursor: out.cursor });
    for (const row of out.rows) seen.add(row.email);
    cursor = out.cursor;
    if (!out.rows.length) break;
  }
  expect(seen.size === (weak ? 500 : 501), 'equal timestamps cannot drop the last page after the fix');
  await display(weak ? 'timestamp cursor skipped one of 501 rows' : 'all 501 equal-timestamp rows exported', { distinctRows: seen.size, pages });
  await fetch(base + '/__bench/hold-delayed', { method: 'POST' });
  await fetch(base + '/__scheduled?cron=41+*+*+*+*');
  const deadline = Date.now() + 10000;
  let state;
  do {
    state = await (await fetch(base + '/__bench/state')).json();
    if (state.rows.some((r) => r.email === 'delayed@example.com') && !state.gaps.length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  expect(state.rows.some((r) => r.email === 'delayed@example.com') && !state.gaps.length, 'the scheduled handler really repaired the old inquiry');
  const delayed = await pull(cursor);
  expect(delayed.rows.some((r) => r.email === 'delayed@example.com' && r.note === 'Complete delayed inquiry') === !weak, 'late repair appears after an already advanced cursor');
  cursor = delayed.cursor;
  await display(weak ? 'repaired inquiry exists in D1 but is never exported' : 'old inquiry repaired later is exported whole', { databaseHasDelayed: true, exportedRows: delayed.rows, cursor });
  const email = 'person-0000@example.com';
  const r = await fetch(base + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example' }, body: JSON.stringify({ site: 'demo', email, note: 'A later complete inquiry 🙂' }) });
  expect(r.ok, 'a later inquiry from an existing subscriber was captured');
  const update = await pull(cursor);
  expect(update.rows.some((r) => r.email === email && r.note.includes('A later complete inquiry 🙂')) === !weak, 'a later inquiry is an export change');
  cursor = update.cursor;
  const unsub = await fetch(base + '/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: 'demo', email }) });
  expect(unsub.ok, 'current unsigned unsubscribe integration accepted without Origin');
  const unsubscribed = await pull(cursor);
  expect(unsubscribed.rows.some((r) => r.email === email && r.unsubscribed_at) === !weak, 'unsubscribe is an export change');
  await display(weak ? 'later inquiry and unsubscribe are absent from export' : 'later inquiry and unsubscribe advance the cursor', { inquiryRows: update.rows, unsubscribeRows: unsubscribed.rows, unsignedUnsubscribeStatus: unsub.status });
  if (!weak) {
    const legacy = await pull('2026-01-01T00:00:00.000Z');
    expect(legacy.rows.length === 500 && /^v2:\d+$/.test(legacy.cursor), 'legacy timestamp cursor safely starts a one-time replay');
    const bad = await fetch(base + '/export?site=demo&since=broken', { headers: auth });
    expect(bad.status === 400, 'invalid cursor is explicit');
    note('legacy cursor upgrade', { count: legacy.rows.length, cursor: legacy.cursor, invalidStatus: bad.status });
  }
}
