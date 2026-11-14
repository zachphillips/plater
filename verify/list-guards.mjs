// API evidence for request boundaries. Uses the local list-entry.js bench;
// synthetic addresses and simulated mail only. No browser surface exists.
export async function journey({ page, step, note, expect }) {
  const base = process.env.LIST_GUARD_URL || 'http://127.0.0.1:24201';
  const weak = Boolean(process.env.GUARDS_EXPECT_WEAK);
  const stamp = Date.now();
  const results = [];
  async function post(id, body, { origin = 'https://demo.example', type = 'application/json', path = '/subscribe', expected, baseline = 200 } = {}) {
    const email = `${id}-${stamp}@example.com`;
    const payload = { site: 'demo', email, ...body };
    const r = await fetch(base + path, { method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': type }, body: JSON.stringify(payload) });
    const response = await r.json();
    const state = await (await fetch(base + '/__bench/state')).json();
    const row = state.rows.find((s) => s.email === payload.email);
    const result = { case: id, status: r.status, response, stored: Boolean(row), unsubscribed: Boolean(row?.unsubscribed_at), cache: r.headers.get('cache-control'), expected: weak ? baseline : expected };
    results.push(result);
    expect(r.status === result.expected, `${id}: expected ${result.expected}, got ${r.status}`);
    if (!weak && expected >= 400) {
      expect(path === '/unsubscribe' ? !row?.unsubscribed_at : !row, `${id}: refused requests have no database side effect`);
      expect(!state.gaps.some((g) => g.value.sub?.email === payload.email), `${id}: refused request has no delivery journal`);
    }
    return { row, email };
  }
  await post('foreign-json', { note: 'A foreign-origin inquiry must not be written.' }, { origin: 'https://foreign.example', expected: 403 });
  await post('plain-text', { note: 'A browser form can send text/plain without a preflight.' }, { type: 'text/plain', expected: 415 });
  await post('wrong-site-origin', { site: 'thekitchen', note: 'An allowed fleet origin cannot post as a different site.' }, { expected: 403 });
  await post('valid-no-origin', { note: 'Command-line integrations can still post JSON.' }, { origin: '', expected: 200 });
  await post('header-control', { email: `bad\u0000-${stamp}@example.com` }, { expected: 400 });
  await post('unpaired-surrogate', { note: '\ud800' }, { expected: 400 });
  if (!weak) await post('unpaired-address', { email: `bad\ud800-${stamp}@example.com` }, { expected: 400 });
  const whitespace = await post('whitespace-note', { note: ' \t\n ' }, { expected: 200 });
  expect(weak ? whitespace.row?.note === null : whitespace.row?.note === ' \t\n ', 'whitespace note is preserved exactly after the fix');
  const seed = await post('unsubscribe-seed', { note: 'Keep me unless the request comes from this site.' }, { expected: 200 });
  await post('foreign-unsubscribe', { email: seed.email }, { origin: 'https://foreign.example', path: '/unsubscribe', expected: 403 });
  await post('large-unsubscribe', { email: seed.email, unused: 'x'.repeat(5000) }, { path: '/unsubscribe', expected: 413 });
  for (const endpoint of ['/list', '/gaps', '/export?site=demo']) {
    for (const credential of ['', 'wrong', 'local-proof-only']) {
      const r = await fetch(base + endpoint, { headers: credential ? { authorization: 'Bearer ' + credential } : {} });
      const body = await r.json();
      results.push({ case: endpoint, credential: credential === 'local-proof-only' ? 'correct synthetic token' : credential || 'missing', status: r.status, privateResponseHasNoStore: r.headers.get('cache-control') === 'no-store', bodyKeys: Object.keys(body) });
      expect(r.status === (credential === 'local-proof-only' ? 200 : 401), `${endpoint}: private reads require the correct token`);
      if (!weak) expect(r.headers.get('cache-control') === 'no-store', 'private data is not cached');
    }
  }
  const allowed = await fetch(base + '/subscribe', { method: 'OPTIONS', headers: { origin: 'https://demo.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  const foreign = await fetch(base + '/subscribe', { method: 'OPTIONS', headers: { origin: 'https://foreign.example', 'access-control-request-method': 'POST' } });
  expect(allowed.headers.get('access-control-allow-origin') === 'https://demo.example' && !foreign.headers.has('access-control-allow-origin'), 'preflight only grants configured origins');
  note('HTTP boundary checks and D1 read-backs', { results, preflight: { allowed: allowed.status, foreign: foreign.status } });
  await page.locator('#results').evaluate((el, value) => { el.textContent = value.map((r) => `${r.case}: HTTP ${r.status}${r.stored === undefined ? '' : `, stored=${r.stored}`}${r.unsubscribed === undefined ? '' : `, unsubscribed=${r.unsubscribed}`}`).join('\n'); }, results);
  await step(weak ? 'original foreign writes accepted and controls lost' : 'foreign writes refused and private reads protected');
}
