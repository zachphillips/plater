import fs from 'node:fs';
export async function journey({ page, step, expect, note }) {
 const bench = JSON.parse(fs.readFileSync(process.env.DRAFT_READ_BENCH_FILE, 'utf8'));
 const weak = Boolean(process.env.DRAFT_READ_EXPECT_WEAK);
 const results = [];
 for (const route of ['api/content?track=outside', 'api/content?file=versions/safe/leaked.json', 'api/versions?track=outside&page=/', 'api/versions?track=safe&page=/leaked/']) {
  const r = await fetch(bench.url + route);
  const body = await r.text();
  const exposed = body.includes('synthetic-private-draft-sentinel');
  const alreadyGuarded = route.includes('file=');
  expect(weak && !alreadyGuarded ? r.status === 200 && exposed : r.status >= 400 && !exposed, route + ': files outside content must not be read');
  results.push({ route, status: r.status, privateFixtureExposed: exposed });
 }
 for (const route of ['api/content?track=safe', 'api/versions?track=safe&page=/']) {
  const r = await fetch(bench.url + route); const body = await r.text();
  expect(r.status === 200 && body.includes('safe draft'), 'legitimate draft stays readable');
  results.push({ route, status: r.status, safeDraftReadable: true });
 }
 note('Real production HTTP replies with synthetic private sentinel', results);
 await page.goto(bench.url);
 await page.evaluate((rows) => { const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; p.textContent = JSON.stringify(rows, null, 2); document.querySelector('main').prepend(p); }, results);
 await step(weak ? 'draft APIs read files outside the content directory through symlinks' : 'draft API reads cannot escape the content directory');
}
