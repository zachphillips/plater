// Real EventSource notifications from the production server's file watcher.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.LIVE_AUTOSAVE_BENCH_FILE, 'utf8'));
  const read = () => JSON.parse(fs.readFileSync(bench.contentPath, 'utf8'));
  const git = (...args) => execFileSync('git', ['-C', bench.siteDir, ...args], { encoding: 'utf8' }).trim();
  const commit = (content) => {
    fs.writeFileSync(bench.contentPath, JSON.stringify(content, null, 2));
    git('add', 'content/site.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic remote edit during live typing');
    return git('rev-parse', 'HEAD');
  };
  // The normal headless shortcut disables live updates; exercise the same
  // automatic stream that a person's browser opens with ?edit instead.
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  page.on('dialog', (d) => d.accept(bench.editToken));
  await page.goto(bench.url + '?edit');
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.waitForFunction(() => window.__platerLive === 'core');
  await page.evaluate(() => {
    window.proofLiveEvents = [];
    document.addEventListener('plater:live', (e) => window.proofLiveEvents.push(e.detail));
  });
  const h1 = page.locator('h1');
  const own = `My uncommitted live headline ${Date.now()}`;
  await h1.fill(own);
  const remote = read(); remote.hero.headline = `Their competing headline ${Date.now()}`;
  remote.hero.subhead = 'Their unrelated paragraph must survive';
  const remoteSha = commit(remote);
  await page.waitForFunction(() => window.proofLiveEvents.length > 0);
  await page.waitForFunction(() => /review.*continue editing/i.test(document.querySelector('#cms-status').textContent));
  const unexpected = await page.waitForRequest((r) => r.url().endsWith('/api/save'), { timeout: 2700 }).catch(() => null);
  expect(!unexpected && git('rev-parse', 'HEAD') === remoteSha, 'SSE same-field conflict pauses the pending autosave before it overwrites the remote commit');
  expect(await h1.textContent() === own, 'SSE keeps the locally typed headline visible');
  expect(await page.evaluate((text) => Object.keys(localStorage).some((k) => k.startsWith('plater.buf.') && JSON.parse(localStorage.getItem(k)).content.hero.headline === text), own), 'local recovery contains the whole competing headline');
  note('Actual SSE conflict read-back', { own, remote: remote.hero.headline, remoteSha, currentHead: git('rev-parse', 'HEAD'), events: await page.evaluate(() => window.proofLiveEvents) });
  await step('live event pauses autosave and preserves both competing versions');
  const unrelated = read(); unrelated.hero.subhead = 'A later background paragraph also survives';
  commit(unrelated);
  await expect.text('[data-bind="hero.subhead"]', unrelated.hero.subhead);
  await expect.text('#cms-status', 'review it and continue editing');
  await step('later background events preserve the conflict pause');
  const revised = `Reviewed SSE conflict and revised ${Date.now()}`;
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/save') && r.ok());
  await h1.fill(revised); await saved;
  expect(read().hero.headline === revised && read().hero.subhead === unrelated.hero.subhead, 'deliberate revision resumes autosave with unrelated remote edits intact');
  note('Reviewed edit committed', { content: read().hero, head: git('rev-parse', 'HEAD') });
  await step('reviewed typing commits automatically with the newer paragraph');
}
