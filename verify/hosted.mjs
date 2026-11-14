// node verify/hosted.mjs — drive hosted Plater end to end in a real browser.
//
// The real packages/hosted/worker.js runs under Node with local stand-ins for
// its Cloudflare bindings (packages/hosted/local.mjs: D1 = node:sqlite with the
// real schema, R2 in memory, Access = a local key signing the same assertion the
// edge sends). The journey:
//   share   `plater share` publishes examples/static-site → v1, permanent links
//   edit    headless Chromium edits the headline in place → saved as v2
//   note    ✎ Note on the headline → queued; the real runner (with a stand-in
//           plan turn that edits the page) makes v3; the open tab reloads by itself
//   keep    /v1/ still shows v1's headline, read-only, with a read-only pill
//   review  the history page lists v1–v3 with their sources; "Mark reviewed" records it
// Playwright is needed (npm i --no-save playwright@1.64.1). Screenshots go to
// PLATER_EVIDENCE_DIR when set. No Cloudflare account, no OpenAI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { _resetAccessCache } from '../packages/hosted/worker.js';
let local; try { local = await import('../packages/hosted/local.mjs'); } catch { console.log('skip verify:hosted: needs node:sqlite (Node 22+)'); process.exit(0); }
const { access, hostedEnv, serveWorker } = local;
import { createRunner } from '../packages/hosted/runner.mjs';
import { share } from '../cli/share.mjs';
import { saveRecord } from '../packages/agent-host/chatgpt-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.PLATER_EVIDENCE_DIR || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.error('verify/hosted needs Playwright: npm i --no-save playwright@1.64.1'); process.exit(1); }

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${String(detail).slice(0, 600)}` : ''}`); if (!ok) failures++; };
const OWNER = 'owner@example.test';

_resetAccessCache();
const acc = access();
const env = hostedEnv(acc);
const { server, url } = await serveWorker(worker, env, { identity: () => OWNER, acc });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-hosted-verify-'));
// The editor keeps live updates off for automated browsers (so screenshots
// settle); launch without the automation flag so this tab behaves like Safari.
const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });

try {
  /* share */
  const out = await share(path.join(ROOT, 'examples', 'static-site'), { url, token: 'publish-test-token', project: 'static-site', by: 'verify', message: 'first draft' });
  check(out.version === 1 && out.url.endsWith('/static-site/') && out.permalink.endsWith('/static-site/v1/'), 'share: v1 with a latest link, a permanent link and a history link', JSON.stringify(out));
  const again = await share(path.join(ROOT, 'examples', 'static-site'), { url, token: 'publish-test-token', project: 'static-site', by: 'verify' });
  check(again.version === 2, 'share again: a new version, never an overwrite');
  const originalHeadline = (await (await fetch(`${url}/api/content`, { headers: { referer: `${url}/static-site/v1/` } })).json()).hero?.headline;

  /* edit */
  const page = await browser.newPage({ viewport: { width: 1210, height: 834 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
  await page.goto(`${url}/static-site/?edit`);
  await page.getByText(`signed in as ${OWNER}`).waitFor({ timeout: 10_000 });
  check(await page.getByText('v2 · history').isVisible(), 'page: the version pill names the version and links to its history');
  await shot('1-signed-in');
  await page.getByRole('button', { name: 'Edit page' }).click();
  const headline = `Edited on plater.thekitchen.co ${Date.now()}`;
  await page.locator('h1').fill(headline);
  await page.waitForFunction(() => /saved & committed v\d+/.test(document.querySelector('#cms-status')?.textContent || ''), null, { timeout: 15_000 });
  const said = await page.locator('#cms-status').textContent();
  check(/saved & committed v3/.test(said), 'edit: typing on the page saves a new version (v3)', said);
  await shot('2-edited');

  /* note */
  await page.locator('#cms-bar button', { hasText: '✎ Note' }).first().click();
  await page.locator('h1').first().click();
  await page.locator('.zmscap-pop textarea').fill('Add a line under the headline saying this came from a note');
  await shot('3-note');
  await page.locator('.zmscap-pop button', { hasText: /send/i }).first().click();
  await page.waitForFunction(() => /queued · [a-f0-9]{12}/.test(document.querySelector('.zmscap-pop')?.textContent || ''), null, { timeout: 10_000 });
  check(true, 'note: ✎ Note on the page queues the note');
  const cred = path.join(work, 'cred');
  saveRecord(cred, { client_id: 'oaiapp_fixture', access_token: 'a', refresh_token: 'r', scope: 'chatgpt.tokens.use.direct', expires_at: Date.now() + 3600_000 });
  let promptSeen = '';
  const runner = createRunner({ url, token: 'runner-test-token', owner: OWNER, workRoot: work, log: () => {},
    env: { PLATER_CHATGPT_PLAN: '1', PLATER_CHATGPT_DIR: cred },
    run: async ({ cwd, prompt }) => {
      promptSeen = prompt;
      const f = path.join(cwd, 'index.html');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('</h1>', '</h1><p id="from-note">This line came from a note.</p>'));
      return { ok: true, status: 'completed' };
    } });
  check(await runner.once(), 'runner: claimed the note');
  check(/Add a line under the headline/.test(promptSeen) && /CSS selector: h1/.test(promptSeen), 'runner: the plan turn got the note and the element it was left on');
  await page.locator('#from-note').waitFor({ timeout: 15_000 }).catch(() => {});
  check(await page.locator('#from-note').isVisible(), 'note: the open tab reloaded by itself and shows the result (v4)');
  check((await page.locator('h1').textContent()) === headline, 'note: the edit typed before the note is still there');
  await shot('4-note-applied');

  /* keep */
  const v1 = await browser.newPage({ viewport: { width: 1210, height: 834 } });
  await v1.goto(`${url}/static-site/v1/`);
  await v1.getByText('v1 of 4 · read-only · history').waitFor({ timeout: 10_000 });
  check((await v1.locator('h1').textContent()) === originalHeadline, 'keep: /v1/ still shows the original headline', await v1.locator('h1').textContent());
  check(!(await v1.locator('#cms-bar button', { hasText: 'Edit page' }).isVisible().catch(() => false)), 'keep: an older version offers no editing');
  if (SHOTS) await v1.screenshot({ path: path.join(SHOTS, '5-v1-kept.png') });

  /* review */
  const rv = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await rv.goto(`${url}/static-site/review`);
  const body = await rv.locator('main').textContent();
  check(/v4[\s\S]*note applied[\s\S]*v3[\s\S]*edited on the page[\s\S]*v2[\s\S]*shared by an agent[\s\S]*v1[\s\S]*shared by an agent/.test(body), 'review: every version listed with how it was made');
  check(/done[\s\S]*Add a line under the headline[\s\S]*became v4/.test(body), 'review: the note is recorded with the version it became');
  await rv.locator('form:has(input[value="4"]) button').click();
  await rv.waitForLoadState();
  check(/reviewed .* by owner@example\.test/.test(await rv.locator('main').textContent()), 'review: "Mark reviewed" records who and when');
  if (SHOTS) await rv.screenshot({ path: path.join(SHOTS, '6-history.png'), fullPage: true });
  const idx = await browser.newPage(); await idx.goto(`${url}/`);
  check(/reviewed/.test(await idx.locator('main').textContent()), 'index: the project list shows it reviewed');
  if (SHOTS) await idx.screenshot({ path: path.join(SHOTS, '7-index.png') });

  /* the gate, from the browser's side */
  const anon = await serveWorker(worker, env, { identity: () => null, acc });
  check((await fetch(`${anon.url}/static-site/`)).status === 403, 'gate: without Access sign-in, nothing loads');
  anon.server.close();
  check(errors.length === 0, 'page: no console errors', errors.join(' | '));
} catch (e) {
  check(false, 'hosted journey', e.stack || e.message);
} finally {
  await browser.close(); server.close(); acc.restore();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nhosted Plater verified (local stand-ins for Cloudflare; no OpenAI)');
process.exit(failures ? 1 : 0);
