// Actual live editor and local git commits, with controlled HTTP failures.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
export async function journey({ page, step, expect, note }) {
 const bench = JSON.parse(fs.readFileSync(process.env.LIVE_AUTOSAVE_BENCH_FILE, 'utf8'));
 const weak = Boolean(process.env.LIVE_AUTOSAVE_EXPECT_WEAK);
 const read = () => JSON.parse(fs.readFileSync(bench.contentPath, 'utf8'));
 const git = (...args) => execFileSync('git', ['-C', bench.siteDir, ...args], { encoding: 'utf8' }).trim();
 const waitStored = async (text) => {
  const end = Date.now() + 14000;
  while (read().hero.headline !== text && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(read().hero.headline === text, 'actual git-backed content eventually contains the whole edit');
 };
 page.on('dialog', (d) => d.accept(bench.editToken));
 await page.goto(bench.url + '?edit&shot=1');
 await page.getByRole('button', { name: 'Edit page' }).click();
 const h1 = page.locator('h1');
 const text = `Live text needs no Save button 🙂 ${Date.now()}`;
 await h1.fill(text);
 if (weak) {
  const wrote = await page.waitForResponse((r) => r.url().endsWith('/api/save'), { timeout: 3200 }).catch(() => null);
  expect(!wrote && read().hero.headline !== text, 'baseline live edits never autosave');
  expect(await page.getByRole('button', { name: 'Save & commit' }).isVisible(), 'baseline requires the manual button');
  note('Typed live text, waited beyond draft autosave delay', { text, storedHeadline: read().hero.headline, requiresSaveButton: true });
  await step('live text still needs a Save button');
  return;
 }
 await waitStored(text);
 expect(!(await page.getByRole('button', { name: 'Save & commit' }).isVisible()), 'no manual Save button is needed or displayed');
 expect(await h1.getAttribute('contenteditable') === 'true', 'autosaving keeps editing available');
 note('Live text persisted without a button', { text, stored: read().hero.headline, head: git('rev-parse', 'HEAD') });
 await step('live writing commits automatically and editing continues');
 let refused = false;
 await page.route('**/api/save', async (route) => {
  if (!refused) { refused = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary local proof refusal' }) }); }
  return route.continue();
 });
 const retry = `Live retry after a refusal ${Date.now()}`;
 await h1.fill(retry);
 await page.waitForFunction(() => /retrying automatically/.test(document.querySelector('#cms-status').textContent));
 expect(read().hero.headline !== retry, 'a refused write is never called saved');
 await step('temporary refusal keeps a recovery copy and retries');
 await page.evaluate(() => window.dispatchEvent(new Event('online')));
 await waitStored(retry);
 await page.unroute('**/api/save');
 let release;
 const gate = new Promise((r) => { release = r; });
 let held = false;
 await page.route('**/api/save', async (route) => { if (!held) { held = true; await gate; } return route.continue(); });
 const first = `First in-flight edit ${Date.now()}`, second = `Newer typing survives the in-flight save ${Date.now()}`;
 const requested = page.waitForRequest((r) => r.url().endsWith('/api/save'));
 await h1.fill(first); await requested;
 await h1.fill(second); release();
 await waitStored(second);
 await page.unroute('**/api/save');
 note('In-flight edits and retry', { refusedOnce: refused, stored: read().hero.headline, head: git('rev-parse', 'HEAD') });
 await step('newer typing also reaches a later automatic commit');
 const remote = read(); remote.hero.headline = 'Other editor owns this competing headline'; remote.hero.subhead = 'Keep the other editor paragraph';
 fs.writeFileSync(bench.contentPath, JSON.stringify(remote, null, 2));
 git('add', 'content/site.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic competing edit');
 const competing = `My conflicting headline ${Date.now()}`;
 await h1.fill(competing);
 await page.waitForFunction(() => /review.*continue editing/i.test(document.querySelector('#cms-status').textContent));
 const next = await page.waitForResponse((r) => r.url().endsWith('/api/save'), { timeout: 2600 }).catch(() => null);
 expect(!next && read().hero.headline === remote.hero.headline, 'a same-field conflict pauses autosave without overwriting the other editor');
 expect(await h1.textContent() === competing, 'the competing local text stays visible');
 const recovery = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('plater.buf.')));
 expect(recovery, 'the conflicting text has a recovery copy');
 await step('conflict keeps both versions safe and waits for a human edit');
 const resolved = `Reviewed and revised headline ${Date.now()}`;
 await h1.fill(resolved); await waitStored(resolved);
 expect(read().hero.subhead === remote.hero.subhead, 'resolving one field preserves newer unrelated text');
 note('Conflict then explicit revised edit', { remoteHeadline: remote.hero.headline, localKept: competing, resolved: read().hero.headline, unrelatedText: read().hero.subhead });
 await step('reviewing and editing resumes autosave');
 let expired = false;
 await page.route('**/api/save', async (route) => {
  if (!expired) { expired = true; return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic expired credential' }) }); }
  return route.continue();
 });
 const signedBackIn = `Typing survives sign-in expiry ${Date.now()}`;
 await h1.fill(signedBackIn);
 await page.getByRole('button', { name: 'Sign in to edit' }).waitFor();
 expect(read().hero.headline !== signedBackIn, 'refused credentials commit nothing');
 expect(await h1.textContent() === signedBackIn, 'sign-in expiry preserves visible writing');
 await step('sign-in expiry keeps the writing and offers sign-in');
 await page.getByRole('button', { name: 'Sign in to edit' }).click();
 await waitStored(signedBackIn);
 await page.unroute('**/api/save');
 note('Signing back in resumes without another edit', { expiredOnce: expired, stored: read().hero.headline });
 await step('signing back in commits the pending writing automatically');
}
