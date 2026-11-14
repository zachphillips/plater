// The edit assistant, driven in a real browser on the real page against the
// assist bench (verify/assist-bench.mjs: production `plater serve`, a temp git
// repo standing in for GitHub, a local stand-in for Anthropic).
//
//   visitor   sees no assistant, and the page makes no /api/assist call
//   editor    taps a text, "Ask Claude", gives an instruction, sees the
//             proposal in place, hatched and locked; nothing is committed and
//             the recovery copy does not hold it; "Use this" saves it as a
//             normal CMS commit
//   discard   "Discard" puts the text back; leaving the page drops a proposal
//             with no unsaved-changes prompt and no commit
//   errors    a busy upstream (429) is one plain line, nothing changes
//   money     one usage-log line per billed response; the key is in no response
//
// Runs under `evidence run --journey` and from verify/editor.mjs (CI). Only
// uses expect(cond, msg), step() and note(), so both harnesses can drive it.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export async function journey({ page, step, expect, note }) {
  const b = JSON.parse(fs.readFileSync(process.env.ASSIST_BENCH_FILE || '/tmp/plater-assist-bench.json', 'utf8'));
  const git = (...args) => execFileSync('git', ['-C', b.siteDir, ...args], { encoding: 'utf8' }).trim();
  // Every pass starts from the demo's own copy.
  if (fs.readFileSync(b.contentPath, 'utf8') !== b.original) {
    fs.writeFileSync(b.contentPath, b.original);
    git('add', 'content/site.json');
    git('-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '-m', 'journey: reset content');
  }
  const mode = (m) => fetch(`${b.standin}/__mode/${m}`, { method: 'POST' });
  await mode('ok');
  const original = JSON.parse(b.original);
  const logLines = () => (fs.existsSync(b.usageLog) ? fs.readFileSync(b.usageLog, 'utf8').split('\n').filter(Boolean) : []);
  const commits = () => Number(git('rev-list', '--count', 'HEAD'));
  const headline = () => JSON.parse(git('show', 'HEAD:content/site.json')).hero.headline;
  const chip = page.getByRole('button', { name: '✦ Ask Claude' });
  const logBefore = logLines().length;

  const assistCalls = [];
  const bodies = [];
  page.on('response', async (r) => {
    if (!new URL(r.url()).pathname.startsWith('/api/')) return;
    const text = await r.text().catch(() => '');
    bodies.push(text);
    if (new URL(r.url()).pathname === '/api/assist') assistCalls.push(r.status());
  });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.type()); d.type() === 'prompt' ? d.accept(b.editToken) : d.dismiss(); });

  /* ---- a visitor ---- */
  await page.goto(b.url);
  await page.locator('h1', { hasText: original.hero.headline }).waitFor();
  await page.locator('h1').click();
  expect(await chip.count() === 0, 'a visitor sees no assistant');
  await step('a visitor sees the page and no assistant');

  /* ---- an editor asks, sees the proposal, accepts ---- */
  await page.goto(b.url + '?edit');
  await page.getByText('edit token set').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.locator('h1').click();
  await chip.waitFor();
  await step('signed in, tapping a text shows Ask Claude');
  await chip.click();
  await page.getByLabel('What should change').fill('Translate this to Spanish.');
  await step('the instruction');
  const before = commits();
  await page.getByRole('button', { name: 'Propose' }).click();
  await page.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
  const proposal = (await page.locator('h1').textContent()).trim();
  expect(proposal === 'Edita esta página en el navegador.', `the proposal is shown in place (got ${proposal})`);
  expect(await page.locator('h1').getAttribute('contenteditable') === 'false', 'the proposal is locked until accepted');
  await step('the proposal in place, hatched, not saved');
  // Longer than the 2s autosave: still nothing committed, and the recovery copy does not hold it.
  await page.waitForTimeout(2600);
  expect(commits() === before, 'a shown proposal is never committed');
  expect(!(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('plater.buf.') && localStorage.getItem(k).includes('Edita')))),
    'the recovery copy never holds a proposal');
  await page.getByRole('button', { name: 'Use this' }).click();
  await page.waitForFunction(() => /saved & committed/.test(document.querySelector('#cms-status')?.textContent || ''), null, { timeout: 15_000 });
  expect(commits() === before + 1 && headline() === proposal, 'accepting commits the proposal like a hand edit');
  note('accepted proposal committed', { commit: git('log', '-1', '--format=%h %s'), headline: headline() });
  await step('accepted, saved and committed like a hand edit');

  /* ---- discard ---- */
  const sub = page.locator('p.subhead');
  await sub.click();
  await chip.click();
  await page.getByRole('button', { name: 'Shorter' }).click();
  await page.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
  const shorter = (await sub.textContent()).trim();
  expect(shorter !== original.hero.subhead, 'a shorter subhead is proposed');
  await step('a proposal for the paragraph');
  const beforeDiscard = commits();
  await page.getByRole('button', { name: 'Discard' }).click();
  expect((await sub.textContent()).trim() === original.hero.subhead, 'discard puts the text back');
  await page.waitForTimeout(2600);
  expect(commits() === beforeDiscard, 'discarding commits nothing');
  await step('discarded, the text is as it was');

  /* ---- leaving the page drops a proposal ---- */
  await sub.click();
  await chip.click();
  await page.getByRole('button', { name: 'Warmer' }).click();
  await page.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
  await step('a proposal left on the page');
  const dialogsBefore = dialogs.filter((t) => t === 'beforeunload').length;
  await page.reload();
  await page.locator('p.subhead', { hasText: original.hero.subhead }).waitFor({ timeout: 10_000 });
  expect(dialogs.filter((t) => t === 'beforeunload').length === dialogsBefore, 'leaving with a proposal shows no unsaved-changes prompt');
  expect(commits() === beforeDiscard, 'leaving with a proposal commits nothing');
  await step('after leaving, the proposal is gone and nothing was saved');

  /* ---- a busy upstream ---- */
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.locator('h1').click();
  await chip.click();
  await mode('429');
  await page.getByLabel('What should change').fill('Make this warmer.');
  await page.getByRole('button', { name: 'Propose' }).click();
  await page.getByText('Claude is busy right now. Try again in a minute.').waitFor({ timeout: 10_000 });
  expect((await page.locator('h1').textContent()).trim() === proposal, 'an error changes nothing');
  await step('a busy upstream, one plain line, nothing changed');
  await mode('ok');
  await page.keyboard.press('Escape');

  /* ---- money and the key ---- */
  const billed = assistCalls.filter((s) => s === 200).length;
  const added = logLines().slice(logBefore);
  expect(added.length === billed, `one usage line per billed response (${added.length} lines, ${billed} billed)`);
  expect(!bodies.some((t) => t.includes(b.key) || t.includes('wrkspc_standin')), 'the key never reaches the browser');
  expect(!added.some((l) => /Edita|Translate|@/.test(l)), 'the usage log holds no prompt, reply or email');
  note('usage log', { billedResponses: billed, linesAdded: added.length, lastLine: added.at(-1) ? JSON.parse(added.at(-1)) : null });
  note('assist responses seen by the browser', assistCalls);
}
