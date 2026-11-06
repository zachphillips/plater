// evidence journey for a disposable plater dev fixture, with its real editor
// loaded using initPlater({ live: true }). PLATER_PROOF_DIR contains only
// synthetic content/site.json and a stream-state file for a fault proxy.
import fs from 'node:fs';
import path from 'node:path';

export async function journey({ page, step, expect, note }) {
  const dir = process.env.PLATER_PROOF_DIR;
  if (!dir || !fs.existsSync(path.join(dir, 'proof-fixture'))) throw Error('PLATER_PROOF_DIR must name a disposable proof fixture');
  const content = path.join(dir, 'content', 'site.json');
  const write = (total) => fs.writeFileSync(content, JSON.stringify({ title: 'Synthetic review page', total }));
  fs.writeFileSync(path.join(dir, 'stream-state'), 'open');
  write('$100');
  await page.goto(new URL('/?draft=new-track', page.url()).href);
  await page.waitForFunction(() => document.querySelector('[data-bind="total"]')?.textContent === '$100');
  await step('new draft starts from live content');
  write('$250');
  await page.waitForFunction(() => document.querySelector('[data-bind="total"]')?.textContent === '$250', null, { timeout: 8000 });
  note('disk update read back', { onDisk: JSON.parse(fs.readFileSync(content, 'utf8')).total, onScreen: await page.locator('[data-bind="total"]').textContent() });
  await step('new draft follows live disk changes');

  // Move to a non-draft page so this checks a separate failure mode. The proxy
  // drops the real SSE connection, then replies HTTP 204 to stop native retry.
  await page.goto(new URL('/?live', page.url()).href);
  await page.waitForFunction(() => document.querySelector('[data-bind="total"]')?.textContent === '$250');
  await page.waitForTimeout(300);
  fs.writeFileSync(path.join(dir, 'stream-state'), 'closed');
  await page.waitForTimeout(4500);
  write('$375');
  fs.writeFileSync(path.join(dir, 'stream-state'), 'open');
  await page.waitForFunction(() => document.querySelector('[data-bind="total"]')?.textContent === '$375', null, { timeout: 12000 });
  expect(await page.locator('[data-bind="total"]').textContent() === '$375', 'closed stream catches up after recovery');
  note('recovered stream read back', { onDisk: JSON.parse(fs.readFileSync(content, 'utf8')).total, onScreen: await page.locator('[data-bind="total"]').textContent() });
  await step('closed stream reconnects and catches up');
}
