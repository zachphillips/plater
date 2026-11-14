// A real browser reads a draft while another editor commits between the two
// content reads. GitHub is the local git-backed bench; only request timing is
// controlled. No live content, credentials or external writes are involved.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.PROMOTION_BENCH_FILE, 'utf8'));
  const weak = Boolean(process.env.PROMOTION_LOAD_EXPECT_WEAK);
  const git = (...args) => execFileSync('git', ['-C', bench.siteDir, ...args], { encoding: 'utf8' }).trim();
  const original = JSON.parse(fs.readFileSync(bench.contentPath, 'utf8'));
  const overlay = path.join(bench.siteDir, 'content/versions/load-race/site.json');
  fs.mkdirSync(path.dirname(overlay), { recursive: true });
  fs.writeFileSync(overlay, JSON.stringify({ hero: { headline: 'Draft headline during concurrent load' } }));
  git('add', 'content/versions/load-race/site.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic sparse draft for concurrent load');
  const current = structuredClone(original);
  current.hero.subhead = 'New live paragraph committed during draft loading';
  let releaseDraft;
  const draftRead = new Promise((resolve) => { releaseDraft = resolve; });
  let liveIntercepted = false, draftIntercepted = false;
  await page.route('**/api/content*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('track') && !liveIntercepted) {
      liveIntercepted = true;
      // A parallel reader sees the commit after the draft response was read.
      // A serial reader finishes first, then the draft request causes it.
      await Promise.race([draftRead, new Promise((resolve) => setTimeout(resolve, 1500))]);
      return route.continue();
    }
    if (url.searchParams.get('track') === 'load-race' && !draftIntercepted) {
      draftIntercepted = true;
      const response = await route.fetch();
      const body = await response.text();
      fs.writeFileSync(bench.contentPath, JSON.stringify(current, null, 2) + '\n');
      git('add', 'content/site.json');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic live change during draft loading');
      releaseDraft();
      return route.fulfill({ response, body });
    }
    return route.continue();
  });
  page.on('dialog', (dialog) => dialog.accept(bench.editToken));
  await page.goto(bench.url + '?edit&draft=load-race&shot=1');
  await page.locator('h1[contenteditable=true]').waitFor();
  await expect.text('h1', 'Draft headline during concurrent load');
  const remoteSha = git('rev-parse', 'HEAD');
  await step('draft loads while another editor commits a newer live paragraph');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/save') && r.request().postDataJSON()?.promote === 'load-race');
  await page.getByRole('button', { name: '⬆ Make this live' }).click();
  const result = await response;
  const stored = JSON.parse(git('show', 'HEAD:content/site.json'));
  const kept = stored.hero.subhead === current.hero.subhead;
  expect(weak ? result.status() === 200 && !kept : result.status() === 409 && kept && git('rev-parse', 'HEAD') === remoteSha,
    'a change during draft loading cannot validate a stale rendered snapshot');
  note('Concurrent draft load and promotion read-back', { status: result.status(), newerParagraphKept: kept, remoteSha, head: git('rev-parse', 'HEAD') });
  if (!weak) await page.waitForFunction(() => /Reload and review/.test(document.querySelector('#cms-status').textContent));
  await step(weak ? 'parallel reads allow promotion to replace the newer paragraph' : 'promotion refuses the snapshot loaded before the live change');
}
