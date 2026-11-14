// The verify bench (the production `plater serve` on examples/static-site in a
// temp git repo) with the edit assistant switched on against the local
// Anthropic stand-in. No key, no network, no spend.
//
//   node verify/assist-bench.mjs   start both, write their details to
//                                  $ASSIST_BENCH_FILE (default
//                                  /tmp/plater-assist-bench.json) and stay up
//   import { startAssistBench }    what verify/editor.mjs uses
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStandin } from './assist-standin.mjs';

export const STANDIN_KEY = 'sk-ant-standin-not-a-real-key-0000000000';

export async function startAssistBench({ port = 4291 } = {}) {
  const standin = await startStandin();
  // Set before the bench imports the handlers: they read env at import time.
  Object.assign(process.env, {
    PLATER_ASSIST_ANTHROPIC_KEY: STANDIN_KEY,
    PLATER_ASSIST_ANTHROPIC_WORKSPACE: 'wrkspc_standin',
    PLATER_ASSIST_ANTHROPIC_BASE_URL: standin.url,
    PLATER_ASSIST_DAILY_PER_EDITOR: '40',
    PLATER_ASSIST_DAILY_PER_SITE: '80',
  });
  delete process.env.PLATER_ASSIST_USAGE_LOG;   // default: beside the site, in the bench's temp dir
  const { startBench } = await import('./bench.mjs');
  const bench = await startBench({ port });
  const usageLog = path.join(bench.siteDir, '.plater-assist-usage.jsonl');
  const original = fs.readFileSync(bench.contentPath, 'utf8');
  return {
    ...bench, standin, usageLog, key: STANDIN_KEY, original,
    async close() { await bench.close(); await standin.close(); },
  };
}

const entry = (() => { try { return fs.realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const b = await startAssistBench({ port: Number(process.env.PORT) || 4291 });
  const file = process.env.ASSIST_BENCH_FILE || '/tmp/plater-assist-bench.json';
  fs.writeFileSync(file, JSON.stringify({ url: b.url, editToken: b.editToken, siteDir: b.siteDir, contentPath: b.contentPath,
    usageLog: b.usageLog, standin: b.standin.url, key: b.key, original: b.original }), { mode: 0o600 });
  console.log(JSON.stringify({ url: b.url, file }));
  const stop = async () => { await b.close(); fs.rmSync(b.siteDir, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
