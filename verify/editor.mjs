// npm run verify:ci — drive the real editor in a real browser against the
// production server, and read back what a save actually wrote. This is the
// gate CI and the release workflow run; it replaces the unit suites that
// mocked the editor in a vm sandbox.
//
//   1. the write gate over HTTP: /api/save with no bearer and with a wrong
//      bearer is refused (401) and leaves no commit
//   2. a wrong edit token in the browser: ?edit, enter the token, edit the
//      headline; the editor says sign-in failed and nothing is committed
//   3. the right edit token: same edit, autosave; the status line names the
//      commit, the bench repo has exactly one new commit with the edit in
//      content/site.json, and a fresh load of the page shows the new headline
//
// Needs Playwright, which Plater does not depend on. Install it next to the
// checkout without touching package.json:
//   npm i --no-save playwright@1.64.1 && npx playwright install chromium
// SHOTS=<dir> also saves a screenshot after each browser step.
import fs from 'node:fs';
import path from 'node:path';
import { startBench } from './bench.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  console.error('verify:ci needs Playwright: npm i --no-save playwright@1.64.1 && npx playwright install chromium');
  process.exit(2);
}

const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
}

const bench = await startBench({ port: Number(process.env.PORT) || 4290 });
const browser = await chromium.launch();
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const before = { commits: bench.commits(), headline: bench.content().hero.headline };

try {
  /* ---- 1. the write gate, over HTTP ---- */
  const cfg = await (await fetch(bench.url + 'api/config')).json();
  check(cfg.editable === true && cfg.tokenAuth === true && !JSON.stringify(cfg).includes(bench.editToken),
    'config: token sign-in offered, the token itself never sent to the browser', JSON.stringify(cfg));
  const post = (headers) => fetch(bench.url + 'api/save', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ content: { hero: { headline: 'gate breach' } } }) });
  check((await post({})).status === 401, 'save: no bearer is refused with 401');
  check((await post({ authorization: 'Bearer not-the-token' })).status === 401, 'save: wrong bearer is refused with 401');
  check(bench.commits() === before.commits && bench.content().hero.headline === before.headline, 'save: refused writes left no commit and no file change');

  /* ---- 2 + 3. the editor, in a browser ---- */
  async function editAs(token, headline, label) {
    const context = await browser.newContext({ viewport: { width: 1210, height: 834 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', (d) => d.accept(token));
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) }); };
    const status = page.locator('#cms-status');

    await page.goto(bench.url + '?edit');
    await page.getByText('edit token set').waitFor({ timeout: 10_000 });
    await shot('1-signed-in');
    await page.getByRole('button', { name: 'Edit page' }).click();
    const h1 = page.locator('h1');
    await h1.fill(headline);
    check(await page.evaluate((text) => Object.keys(localStorage).some((k) =>
      k.startsWith('plater.buf.') && JSON.parse(localStorage.getItem(k)).content.hero.headline === text), headline),
    'editor: the last keystroke is already in its recovery copy');
    await shot('2-edited');
    check(!(await page.getByRole('button', { name: 'Save & commit' }).isVisible()), 'editor: live typing needs no Save button');
    await page.waitForFunction(() => /saved & committed|sign in again/i.test(document.querySelector('#cms-status')?.textContent || ''), null, { timeout: 10_000 });
    await shot('3-after-save');
    const said = (await status.textContent()) || '';
    await context.close();
    return { said, errors };
  }

  const wrong = await editAs('not-the-token', `Wrong token edit ${stamp}`, 'wrong-token');
  check(/sign in again/i.test(wrong.said), 'editor: a wrong token is told to sign in again', `status: ${wrong.said}`);
  check(bench.commits() === before.commits && bench.content().hero.headline === before.headline, 'editor: the wrong-token save committed nothing');
  check(wrong.errors.length === 0, 'editor: no console errors (wrong-token pass)', wrong.errors.join(' | '));

  const headline = `Edited in the browser by verify:ci ${stamp}`;
  const remote = bench.content();
  remote.hero.subhead = 'A newer paragraph already on GitHub when this old deployment saves.';
  remote.remoteOnly = 'Keep the other editor\'s new field.';
  bench.commitElsewhere(remote, { staleDisk: true });
  const beforeRight = bench.commits();
  const right = await editAs(bench.editToken, headline, 'edit-token');
  const [sha, subject] = bench.lastCommit().split('\x1f');
  check(/saved & committed [0-9a-f]{7,}/.test(right.said) && right.said.includes(sha), 'editor: the status line names the new commit', `status: ${right.said}, HEAD ${sha}`);
  check(bench.commits() === beforeRight + 1, 'save: exactly one commit landed', `${beforeRight} -> ${bench.commits()}`);
  check(/^content\(bench-site\): edit via CMS/.test(subject), 'save: the commit is a CMS content commit', subject);
  check(bench.content().hero.headline === headline, 'save: content/site.json holds the new headline', bench.content().hero.headline);
  check(bench.content().hero.subhead === remote.hero.subhead && bench.content().remoteOnly === remote.remoteOnly,
    'save: the old deployment preserves newer GitHub fields, including a sibling of the edited headline');
  check(right.errors.length === 0, 'editor: no console errors (edit-token pass)', right.errors.join(' | '));

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(bench.url);
  await page.locator('h1', { hasText: headline }).waitFor({ timeout: 10_000 }).catch(() => {});
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'reader-after-save.png') });
  check((await page.locator('h1').textContent()) === headline, 'reader: a fresh page load shows the saved headline');

  // Keep the promotion load race in the real browser CI journey too.
  const { journey: promotionLoad } = await import('./promotion-load-proof.mjs');
  const promotionPage = await browser.newPage({ viewport: { width: 1210, height: 834 } });
  const configFile = path.join(bench.siteDir, '.promotion-proof.json');
  fs.writeFileSync(configFile, JSON.stringify({ url: bench.url, siteDir: bench.siteDir,
    contentPath: bench.contentPath, editToken: bench.editToken }));
  process.env.PROMOTION_BENCH_FILE = configFile;
  const proofExpect = Object.assign((ok, message) => { if (!ok) throw new Error(message); }, {
    text: async (selector, text) => {
      const actual = await promotionPage.locator(selector).textContent();
      if (actual !== text) throw new Error(`${selector}: expected ${text}, got ${actual}`);
    },
  });
  await promotionLoad({ page: promotionPage, expect: proofExpect, note: () => {},
    step: async (name) => {
      if (SHOTS) await promotionPage.screenshot({ path: path.join(SHOTS, `promotion-${name.replace(/\W+/g, '-')}.png`) });
    },
  });
  check(true, 'promotion: a live change during draft loading is refused and the newer commit is preserved');
} catch (e) {
  check(false, 'drive finished without throwing', e.stack || e);
} finally {
  await browser.close();
  await bench.close();
  fs.rmSync(bench.siteDir, { recursive: true, force: true });
}

console.log(failures ? `\nverify:ci FAILED (${failures})` : '\nverify:ci passed');
process.exit(failures ? 1 : 0);
