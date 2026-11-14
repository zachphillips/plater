// `evidence run --journey verify/list-proof.mjs` wraps the local service drive.
// The API has no browser UI. Screenshots show the captured request outcomes;
// manifest side effects contain the HTTP replies and D1/KV/mail read-backs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function journey({ page, step, note, expect }) {
  const runner = fileURLToPath(new URL('./list-worker.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [runner], { env: process.env, encoding: 'utf8', timeout: 58000, maxBuffer: 2 << 20 });
  note('local Worker command', { command: 'node verify/list-worker.mjs', exit: run.status, stderr: run.stderr });
  const result = JSON.parse(fs.readFileSync(path.join(process.env.LIST_PROOF_DIR, 'results.json'), 'utf8'));
  note('HTTP replies and persisted side effects', result);
  for (const [name, entries] of [
    ['whole messages and repeat inquiries', result.results.slice(0, 8)],
    ['outages, slow dependencies and repair', result.results.slice(8, 14)],
    ['worker killed during the request', result.results.slice(14)],
  ]) {
    await page.locator('#results').evaluate((el, data) => { el.textContent = JSON.stringify(data, null, 2); }, entries);
    await step(name, { fullPage: true });
  }
  expect(run.status === 0, 'local service drive passed; see side effects for each failure');
  if (process.env.LIST_EXPECT_FAILURE) expect(result.failures.length > 0, 'baseline defects were reproduced');
}
