// Run from a checkout: node cli/verify-live-safety.mjs [dev|serve]
// Drives a real, disposable CLI server over HTTP. All data is synthetic.
// JSON stdout is a request/response proof transcript; exit 1 means a failed guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mode = process.argv[2] || 'dev';
if (!['dev', 'serve'].includes(mode)) throw Error('expected dev or serve');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-live-safety-'));
const web = path.join(fixture, 'pages');
fs.mkdirSync(path.join(web, 'content'), { recursive: true });
fs.mkdirSync(path.join(web, '.git'));
fs.writeFileSync(path.join(web, 'example.html'), '<!doctype html><title>Safety fixture</title><p>Public page</p>');
fs.writeFileSync(path.join(web, '100%.css'), 'p{color:green}');
fs.writeFileSync(path.join(web, 'bank.json'), '{"synthetic":"private neighboring data"}');
fs.writeFileSync(path.join(web, '.env'), 'FIXTURE_ONLY=not-a-secret');
fs.writeFileSync(path.join(web, '.git', 'config'), 'synthetic private configuration');
fs.writeFileSync(path.join(web, 'content', 'site.json'), '{}');
fs.writeFileSync(path.join(fixture, 'private.css'), 'synthetic private file outside web root');
fs.symlinkSync(path.join(fixture, 'private.css'), path.join(web, 'escape.css'));

const name = mode === 'dev' ? 'startDev' : 'startServe';
const script = `import {${name}} from ${JSON.stringify(pathToFileURL(path.join(root, 'cli', mode + '.mjs')).href)};
const {server}=await ${name}(${JSON.stringify(web)},{port:0});
console.log('READY '+server.address().port);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
const env = { ...process.env };
for (const k of ['GITHUB_EDIT_PATH', 'GITHUB_TOKEN', 'PLATER_WEB_ROOT', 'PLATER_REVIEW_PATH']) delete env[k];
const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', stderr = '';
child.stderr.on('data', (b) => { stderr += b; });
const request = (port, target) => new Promise((resolve) => {
  const r = http.get({ host: '127.0.0.1', port, path: target }, (res) => {
    let body = '';
    res.on('data', (b) => { body += b; });
    res.on('end', () => resolve({ target, status: res.statusCode, type: res.headers['content-type'], excerpt: body.slice(0, 100) }));
  });
  r.on('error', (e) => resolve({ target, error: e.code }));
  r.setTimeout(4000, () => r.destroy(Error('request timeout')));
});
const transcript = [];
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not become ready')), 10000);
    child.stdout.on('data', (b) => {
      log += b;
      const m = /READY (\d+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(Error('server exited before ready: ' + stderr)); });
  });
  const cases = [['/example.html', 200], ['/100%25.css', 200], ['/.env', 404], ['/.git/config', 404], ['/escape.css', 404]];
  if (mode === 'dev') cases.push(['/bank.json', 404]);
  // Put the malformed request last: an unfixed head exits on this request.
  cases.push(['/%ZZ', 400], ['/example.html', 200]);
  for (const [target, expected] of cases) {
    const result = await request(port, target);
    transcript.push({ ...result, expected, pass: result.status === expected });
  }
  const pass = transcript.every((r) => r.pass);
  console.log(JSON.stringify({ mode, pass, transcript, serverStderr: stderr }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}
