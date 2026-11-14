import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ART = '/opt/cursor/artifacts';
const bench = JSON.parse(fs.readFileSync(process.env.LIVE_AUTOSAVE_BENCH_FILE, 'utf8'));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.on('dialog', (d) => d.accept(bench.editToken));
await page.goto(bench.url + '?edit&shot=1');
await page.getByRole('button', { name: 'Edit page' }).click();
await page.route('**/api/save', (r) => r.fulfill({
  status: 503, contentType: 'application/json',
  body: JSON.stringify({ error: 'Synthetic temporary refusal' }),
}));
const text = 'Phone writing stays safe when autosave is refused 🙂';
await page.locator('h1').fill(text);
await page.waitForFunction(() => /retrying automatically/.test(document.querySelector('#cms-status')?.textContent || ''));
await page.reload();
await page.getByRole('button', { name: 'Edit page' }).click();
await page.waitForTimeout(600);
const state = await page.evaluate(() => ({
  editing: document.body.classList.contains('cms-editing'),
  status: document.querySelector('#cms-status')?.textContent,
  banner: document.querySelector('.plater-ed-banner')?.innerText || null,
  h1: document.querySelector('h1')?.textContent,
  restoreVisible: [...document.querySelectorAll('button')].some((b) => b.textContent === 'Restore' && b.getClientRects().length),
}));
await page.screenshot({ path: path.join(ART, '14-after-reload-then-edit-390x844.png') });
if (state.restoreVisible) {
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.waitForTimeout(400);
  state.afterRestoreH1 = await page.locator('h1').textContent();
  state.afterRestoreStatus = await page.locator('#cms-status').textContent();
  await page.screenshot({ path: path.join(ART, '15-after-restore-390x844.png') });
}
fs.writeFileSync(path.join(ART, '14-after-reload-then-edit-390x844.json'), JSON.stringify(state, null, 2));
console.log(JSON.stringify(state, null, 2));
await context.close();
await browser.close();
