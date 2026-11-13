// Real editor + production save handler. Only GitHub is a local fixture;
// every accepted write makes a real commit in the bench repository.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.SAVE_BENCH_FILE, 'utf8'));
  const git = (...args) => execFileSync('git', ['-C', bench.siteDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  page.on('dialog', (d) => d.accept(bench.editToken));
  await page.goto(bench.url + '?edit&shot=1');
  await page.getByText('edit token set').waitFor();
  await page.getByRole('button', { name: 'Edit page' }).click();
  const stamp = Date.now();
  const myHeadline = `My headline ${stamp} must keep their paragraph.`;
  const old = JSON.parse(fs.readFileSync(bench.contentPath, 'utf8'));
  const remote = structuredClone(old);
  remote.hero.subhead = `Another editor already committed this newer paragraph (${stamp}).`;
  remote.remoteOnly = `A newer field that the deployed snapshot does not contain (${stamp}).`;
  fs.writeFileSync(bench.contentPath, JSON.stringify(remote, null, 2));
  git('add', 'content/site.json');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-m', 'Another editor updates the copy');
  const remoteSha = git('rev-parse', 'HEAD');
  // A deployed site can lag GitHub until its next deploy. Keep its disk copy
  // old while the bench Contents API reads the newer committed revision.
  fs.writeFileSync(bench.contentPath, JSON.stringify(old, null, 2));
  await page.locator('h1').fill(myHeadline);
  await step('my edit on the older deployed page');
  const responsePromise = page.waitForResponse((r) => r.url().endsWith('/api/save') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save & commit' }).click();
  const response = await responsePromise;
  await page.waitForFunction(() => /saved/.test(document.querySelector('#cms-status')?.textContent || ''));
  const stored = JSON.parse(git('show', 'HEAD:content/site.json'));
  const kept = stored.hero.subhead === remote.hero.subhead && stored.remoteOnly === remote.remoteOnly;
  note('real commit read-back', { responseStatus: response.status(), reply: await response.json(), remoteSha, head: git('rev-parse', 'HEAD'), saved: stored, keptUnrelatedEdits: kept });
  await step('save acknowledged and committed');
  expect(response.status() === 200 && stored.hero.headline === myHeadline, 'my headline was committed');
  expect(process.env.SAVE_EXPECT_LOSS ? !kept : kept, process.env.SAVE_EXPECT_LOSS ? 'baseline reproduced loss of a newer paragraph and field' : 'newer unrelated paragraph and field survived');
  if (process.env.SAVE_EXPECT_LOSS) return;
  await expect.text('[data-bind="hero.subhead"]', remote.hero.subhead);

  await page.getByRole('button', { name: 'Edit page' }).click();
  const competing = structuredClone(stored);
  competing.hero.headline = `Their different headline ${stamp}`;
  fs.writeFileSync(bench.contentPath, JSON.stringify(competing, null, 2));
  git('add', 'content/site.json');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-m', 'Another editor changes the same headline');
  const competingSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(bench.contentPath, JSON.stringify(stored, null, 2));
  const mySecond = `My competing headline ${stamp}`;
  await page.locator('h1').fill(mySecond);
  const conflictResponse = page.waitForResponse((r) => r.url().endsWith('/api/save') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save & commit' }).click();
  const refused = await conflictResponse;
  await expect.text('#cms-status', 'your edits are kept');
  const conflictReply = await refused.json();
  note('same-field collision', { status: refused.status(), competingSha, head: git('rev-parse', 'HEAD'), latestFromResponse: conflictReply.content, textStillInEditor: await page.locator('h1').textContent() });
  expect(refused.status() === 409 && git('rev-parse', 'HEAD') === competingSha, 'a conflicting same-field edit leaves their commit untouched');
  await expect.text('h1', mySecond);
  await step('conflict keeps my writing and their commit');
  const retryResponse = page.waitForResponse((r) => r.url().endsWith('/api/save') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save & commit' }).click();
  const retry = await retryResponse;
  await expect.text('#cms-status', 'saved & committed');
  const final = JSON.parse(git('show', 'HEAD:content/site.json'));
  note('explicit retry after review', { status: retry.status(), content: final });
  expect(retry.status() === 200 && final.hero.headline === mySecond && final.hero.subhead === remote.hero.subhead, 'reviewed retry retains unrelated content');
  await step('reviewed retry committed with both editors work retained');
}
