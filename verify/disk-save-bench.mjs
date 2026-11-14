// Real local write failures, using this child's OS file-size limit only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDev } from '../cli/dev.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-disk-save-'));
fs.cpSync(path.join(root, 'examples/static-site'), siteDir, { recursive: true });
for (const key of ['GITHUB_TOKEN', 'CMS_GITHUB_TOKEN', 'GITHUB_EDIT_PATH', 'CMS_ADMIN_EMAIL', 'GOOGLE_CLIENT_ID', 'CMS_EDIT_TOKEN', 'PLATER_AGENT_ENDPOINT', 'ZMS_AGENT_ENDPOINT', 'PLATER_REVIEW_PATH']) delete process.env[key];
process.on('SIGXFSZ', () => {});
process.env.PLATER_LIVE = '0';
const out = await startDev(siteDir, { port: Number(process.env.PORT || 24441) });
console.log(JSON.stringify({ url: `http://127.0.0.1:${out.port}/`, siteDir, contentPath: out.contentPath }));
