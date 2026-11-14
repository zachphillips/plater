// Real local dev server on a synthetic site. No GitHub/Google/agent credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDev } from '../cli/dev.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-dev-guards-'));
fs.cpSync(path.join(root, 'examples/static-site'), siteDir, { recursive: true });
fs.writeFileSync(path.join(siteDir, '.env'), 'GITHUB_TOKEN=synthetic-private-sentinel\n');
fs.mkdirSync(path.join(siteDir, '.git'), { recursive: true });
fs.writeFileSync(path.join(siteDir, '.git/config'), 'synthetic-private-sentinel');
for (const key of ['GITHUB_TOKEN', 'CMS_GITHUB_TOKEN', 'GITHUB_EDIT_PATH', 'CMS_ADMIN_EMAIL', 'GOOGLE_CLIENT_ID', 'CMS_EDIT_TOKEN', 'PLATER_AGENT_ENDPOINT', 'ZMS_AGENT_ENDPOINT', 'PLATER_REVIEW_PATH']) delete process.env[key];
const out = await startDev(siteDir, { port: Number(process.env.PORT || 24341), live: false });
console.log(JSON.stringify({ url: `http://127.0.0.1:${out.port}/`, siteDir, contentPath: out.contentPath }));
