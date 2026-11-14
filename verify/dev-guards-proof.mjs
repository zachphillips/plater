// HTTP security journey for the actual local dev server and real disk writes.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.DEV_GUARDS_BENCH_FILE, 'utf8'));
  const weak = Boolean(process.env.DEV_GUARDS_EXPECT_WEAK);
  const localOrigin = new URL(bench.url).origin;
  const results = [];
  // Node's fetch manages Host itself. Use HTTP directly to exercise the
  // authority actually received by the server in the DNS-rebinding case.
  const post = (headers, body) => new Promise((resolve, reject) => {
    const req = http.request(bench.url + 'api/save', { method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(body);
  });
  async function save(name, headers, expected) {
    const before = fs.readFileSync(bench.contentPath, 'utf8');
    const headline = `${name} ${Date.now()}`;
    const r = await post({ 'content-type': 'application/json', ...headers }, JSON.stringify({ content: { hero: { headline } } }));
    const after = fs.readFileSync(bench.contentPath, 'utf8');
    results.push({ name, status: r.status, changedDisk: after !== before });
    expect(r.status === (weak ? 200 : expected), `${name}: expected HTTP ${weak ? 200 : expected}, got ${r.status}`);
    expect(weak || expected === 200 ? after !== before : after === before, `${name}: disk changes only on acceptance`);
  }
  await save('foreign JSON', { origin: 'https://foreign.example' }, 403);
  await save('simple text/plain body', { 'content-type': 'text/plain', origin: 'https://foreign.example' }, 415);
  await save('DNS rebind host', { host: 'rebound.example', origin: 'http://rebound.example' }, 403);
  await save('same origin', { origin: localOrigin }, 200);
  await save('local JSON integration', {}, 200);
  await save('tailnet host', { host: 'dev-proof.tail-example.ts.net', origin: 'http://dev-proof.tail-example.ts.net' }, 200);
  await save('local tailnet proxy', { 'x-forwarded-host': 'dev-proof.tail-example.ts.net', 'x-forwarded-proto': 'https', origin: 'https://dev-proof.tail-example.ts.net' }, 200);
  if (!weak) {
    await save('untrusted forwarded host', { 'x-forwarded-host': 'foreign.example', origin: 'http://foreign.example' }, 403);
    await save('wrong local port', { origin: 'http://127.0.0.1:1' }, 403);
    await save('opaque browser origin', { origin: 'null' }, 403);
    for (const route of ['api/history', 'api/review', 'plater/review-status', 'api/agent-note']) {
      const r = await fetch(bench.url + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://foreign.example' }, body: '{' });
      expect(r.status === 403, route + ' refuses before parsing or side effects');
      results.push({ name: 'foreign ' + route, status: r.status });
    }
    for (const route of ['api/review', 'plater/review-status']) {
      const r = await fetch(bench.url + route, { method: 'HEAD' });
      expect(r.status === 405, 'HEAD cannot change review state');
      results.push({ name: 'HEAD ' + route, status: r.status });
    }
  }
  const images = path.join(bench.siteDir, 'images');
  const beforeImages = fs.existsSync(images) ? fs.readdirSync(images) : [];
  const upload = await fetch(bench.url + 'api/upload', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://foreign.example' }, body: JSON.stringify({ filename: `foreign-${Date.now()}.png`, dataBase64: Buffer.from('synthetic image').toString('base64') }) });
  const afterImages = fs.existsSync(images) ? fs.readdirSync(images) : [];
  expect(upload.status === (weak ? 200 : 403), 'foreign upload follows the same guard');
  expect(weak ? afterImages.length > beforeImages.length : JSON.stringify(beforeImages) === JSON.stringify(afterImages), 'refused foreign upload creates no file');
  results.push({ name: 'foreign upload', status: upload.status, filesCreated: afterImages.length - beforeImages.length });
  for (const file of ['.env', '.git/config']) {
    const r = await fetch(bench.url + file);
    const text = await r.text();
    expect(r.status === 404 && !text.includes('synthetic-private-sentinel'), 'private dotfiles are never served');
    results.push({ name: file, status: r.status, sentinelExposed: text.includes('synthetic-private-sentinel') });
  }
  note('HTTP requests with actual disk read-backs', results);
  await page.goto(bench.url);
  const summary = results.map((r) => `${r.name}: HTTP ${r.status}${r.changedDisk === undefined ? '' : ', changed disk=' + r.changedDisk}`).join('\n');
  await page.evaluate((text) => { const p = document.createElement('pre'); p.textContent = text; p.style.whiteSpace = 'pre-wrap'; document.querySelector('main').prepend(p); }, summary);
  await step(weak ? 'foreign requests and rebound hosts overwrite local content' : 'foreign writes refused while local and tailnet editing work');
}
