import fs from 'node:fs';
export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.DEV_EFFECTS_BENCH_FILE, 'utf8'));
  const weak = Boolean(process.env.DEV_EFFECTS_EXPECT_WEAK);
  const initial = await (await fetch(bench.url + 'api/review')).json();
  expect(initial.pages.length > 0, 'real fixture has reviewable pages');
  const statuses = [];
  for (const p of initial.pages) {
    const r = await fetch(bench.url + 'api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p.path, reviewed: true }) });
    const out = await r.json();
    expect(r.status === 200 && out.ok, 'local review mark is accepted');
    statuses.push({ path: p.path, status: r.status });
  }
  const calls = JSON.parse(fs.readFileSync(bench.callsPath, 'utf8'));
  const writes = calls.filter((c) => c.method === 'PUT');
  const hooks = calls.filter((c) => c.host === 'dev-effects.example.invalid');
  expect(weak ? writes.length > 0 && hooks.length > 0 : calls.length === 0, 'dev never attempts GitHub writes or review webhooks');
  const local = fs.existsSync(bench.reviewPath) ? JSON.parse(fs.readFileSync(bench.reviewPath, 'utf8')) : null;
  if (!weak) expect(initial.pages.every((p) => local[p.path]?.by === 'dev'), 'review marks persist locally');
  note('Actual dev HTTP review marks with intercepted external requests', { statuses, externalCalls: calls, localReviewWritten: Boolean(local), network: 'All external calls intercepted; no real GitHub token or webhook used' });
  await page.evaluate((data) => { const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; p.textContent = JSON.stringify(data, null, 2); document.querySelector('main').prepend(p); }, { pagesMarked: statuses.length, githubWritesAttempted: writes.length, webhookCallsAttempted: hooks.length, localReviewWritten: Boolean(local) });
  await step(weak ? 'local review attempts GitHub writes and a remote webhook' : 'local review stays on disk with both token names configured');
}
