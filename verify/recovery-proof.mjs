// Actual editor recovery and draft retry. The bench uses a real local git
// repository. A single 503 simulates temporary upstream/network refusal.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.RECOVERY_BENCH_FILE, 'utf8'));
  const weak = Boolean(process.env.RECOVERY_EXPECT_WEAK);
  page.on('dialog', (d) => d.accept(bench.editToken));
  const enter = async (draft = '') => {
    await page.goto(bench.url + `?edit&shot=1${draft ? '&draft=' + draft : ''}`);
    if (draft) await page.locator('h1[contenteditable="true"]').waitFor({ timeout: 10000 });
    else {
      await page.getByRole('button', { name: 'Edit page' }).click({ timeout: 10000 });
    }
  };
  const buffers = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('plater.buf.')).map((k) => ({ key: k, value: JSON.parse(localStorage.getItem(k)) })));
  await enter();
  const text = `Last keystroke survives immediately ${Date.now()}`;
  await page.locator('h1').fill(text);
  const immediate = await buffers();
  expect(weak ? !immediate.length : immediate.some((b) => b.value.content.hero.headline === text), 'last keystroke recovery is synchronous after the fix');
  // A real navigation before the old 800 ms buffer timer runs.
  await enter();
  const restore = page.getByRole('button', { name: 'Restore', exact: true });
  if (weak) {
    expect(!(await restore.isVisible()), 'baseline navigation lost the last keystroke');
  } else {
    await restore.waitFor();
    const rect = await restore.boundingBox();
    const view = await page.evaluate(() => ({ left: visualViewport.offsetLeft, width: visualViewport.width, barBottom: document.querySelector('#cms-bar').getBoundingClientRect().bottom }));
    expect(rect.x >= view.left && rect.x + rect.width <= view.left + view.width && rect.y >= view.barBottom, 'Restore is reachable inside the visible viewport below the toolbar');
    note('Restore placement', { rect, view });
    await restore.click();
    await expect.text('h1', text);
    expect((await buffers()).some((b) => b.value.content.hero.headline === text), 'restore keeps the recovery copy immediately');
    await enter();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.text('h1', text);
  }
  note('immediate recovery read-back', { capturedAtInput: immediate, textAfterNavigation: await page.locator('h1').textContent(), weak });
  await step(weak ? 'last keystroke lost on immediate navigation' : 'last keystroke and restored text survive repeated navigation');
  const recovered = `Recovered writing ${Date.now()}`;
  await page.locator('h1').fill(recovered);
  await page.waitForFunction((text) => Object.keys(localStorage).some((k) => k.startsWith('plater.buf.') && JSON.parse(localStorage.getItem(k)).content.hero.headline === text), recovered);
  const contentPath = path.join(bench.siteDir, 'content/site.json');
  const remote = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  remote.hero.subhead = `Another editor's new paragraph ${Date.now()}`;
  fs.writeFileSync(contentPath, JSON.stringify(remote, null, 2));
  execFileSync('git', ['-C', bench.siteDir, 'add', 'content/site.json']);
  execFileSync('git', ['-C', bench.siteDir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-m', 'Another editor updates the paragraph'], { stdio: 'ignore' });
  await enter();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  const restoredBuffer = await buffers();
  const keptRemote = await page.locator('[data-bind="hero.subhead"]').textContent() === remote.hero.subhead;
  expect(weak ? !restoredBuffer.length && !keptRemote : restoredBuffer.some((b) => b.value.content.hero.headline === recovered) && keptRemote, 'restore keeps its buffer and unrelated newer content after the fix');
  note('restore read-back', { bufferKept: Boolean(restoredBuffer.length), unrelatedRemoteParagraphKept: keptRemote, headline: await page.locator('h1').textContent() });
  await step(weak ? 'restore deletes its recovery copy and replaces newer unrelated text' : 'restore keeps its recovery copy and newer unrelated text');
  // Explicitly discard the live-only recovery fixture before the draft leg.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('plater.buf.')) localStorage.removeItem(k); });
  const track = `recovery-${Date.now()}`;
  const overlay = path.join(bench.siteDir, 'content', 'versions', track, 'site.json');
  fs.mkdirSync(path.dirname(overlay), { recursive: true });
  fs.writeFileSync(overlay, '{}\n');
  await enter(track);
  const draftText = `Draft retries without another keystroke ${Date.now()}`;
  let refused = 0;
  await page.route('**/api/save', async (route) => {
    if (!refused++) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary local proof refusal' }) });
    return route.continue();
  });
  await page.locator('h1').fill(draftText);
  await page.waitForFunction(() => /autosave failed|retrying/.test(document.querySelector('#plater-autosave')?.textContent || ''));
  await step('temporary refusal keeps the draft text visible');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  if (weak) {
    // Wait on a possible real response, rather than a sleep. The original has
    // no retry scheduled, so the bounded observation expires.
    await page.waitForResponse((r) => r.url().endsWith('/api/save') && r.ok(), { timeout: 4500 }).catch(() => {});
    expect(JSON.parse(fs.readFileSync(overlay, 'utf8')).hero?.headline !== draftText, 'baseline never retries the failed draft');
  } else {
    await page.waitForFunction(() => /saved ✓/.test(document.querySelector('#plater-autosave')?.textContent || ''));
    expect(JSON.parse(fs.readFileSync(overlay, 'utf8')).hero.headline === draftText, 'automatic retry made a real draft commit');
    expect(!(await buffers()).some((b) => b.key.endsWith('.' + track)), 'confirmed draft commit clears only its recovery copy');
  }
  note('draft retry read-back', { requests: refused, committed: JSON.parse(fs.readFileSync(overlay, 'utf8')).hero?.headline === draftText, draftText, status: await page.locator('#plater-autosave').textContent() });
  await step(weak ? 'failed draft remains uncommitted after online' : 'online recovery commits the draft without another edit');
}
