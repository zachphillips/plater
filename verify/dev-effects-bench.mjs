// Real dev handlers; every external fetch is intercepted before the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDev } from '../cli/dev.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-dev-effects-'));
fs.cpSync(path.join(root, 'examples/static-site'), siteDir, { recursive: true });
process.chdir(siteDir);
process.env.GITHUB_TOKEN = 'synthetic-primary-token';
process.env.CMS_GITHUB_TOKEN = 'synthetic-alias-token';
process.env.GITHUB_REPOSITORY = 'fixture/local';
process.env.PLATER_REVIEW_PATH = '.plater-review.json';
process.env.PLATER_REVIEW_WEBHOOK = 'https://dev-effects.example.invalid/reviewed';
process.env.CMS_DEPLOY_HOOK = 'https://dev-effects.example.invalid/deploy';
process.env.PLATER_LIVE = '0';
for (const key of ['GITHUB_EDIT_PATH', 'CMS_ADMIN_EMAIL', 'GOOGLE_CLIENT_ID', 'CMS_EDIT_TOKEN', 'PLATER_AGENT_ENDPOINT', 'ZMS_AGENT_ENDPOINT']) delete process.env[key];
const callsPath = path.join(siteDir, '.proof-calls.json');
const calls = [];
let state = {};
fs.writeFileSync(callsPath, '[]');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init);
  const method = init.method || 'GET';
  calls.push({ host: u.hostname, path: u.pathname, method });
  fs.writeFileSync(callsPath, JSON.stringify(calls));
  if (u.hostname === 'api.github.com') {
    if (method === 'PUT') {
      state = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
      return Response.json({ commit: { sha: 'synthetic-commit' } });
    }
    return Response.json({ sha: 'synthetic-file-sha', content: Buffer.from(JSON.stringify(state)).toString('base64') });
  }
  if (u.hostname === 'dev-effects.example.invalid') return Response.json({ ok: true });
  throw new Error('External network blocked by fixture');
};
const out = await startDev(siteDir, { port: Number(process.env.PORT || 24541) });
console.log(JSON.stringify({ url: `http://127.0.0.1:${out.port}/`, siteDir, callsPath, reviewPath: path.join(siteDir, '.plater-review.json') }));
