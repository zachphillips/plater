import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.SIZE_BENCH_FILE, 'utf8'));
  const weak = Boolean(process.env.SIZE_EXPECT_WEAK);
  const results = [];
  const send = (route, body, { length = false, leaveOpen = false } = {}) => new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (length) headers['content-length'] = Buffer.byteLength(body);
    let settled = false;
    const req = http.request(bench.url + route, { method: 'POST', headers }, (res) => {
      let reply = ''; res.on('data', (c) => { reply += c; });
      res.on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status: res.statusCode, reply: reply.slice(0, 200), bodyBytes: Buffer.byteLength(body) }); req.destroy(); } });
    });
    const timer = setTimeout(() => { if (!settled) { settled = true; req.destroy(); resolve({ status: null, waitingForUnboundedBody: true, bodyBytes: Buffer.byteLength(body) }); } }, leaveOpen ? 1800 : 10000);
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    if (leaveOpen) req.write(body); else req.end(body);
  });
  for (const length of [false, true]) {
    const before = fs.readFileSync(bench.contentPath, 'utf8');
    const body = JSON.stringify({ content: { hero: { headline: `Oversized ${length}`, subhead: 'x'.repeat(3 * 1024 * 1024) } } });
    const r = await send('api/save', body, { length });
    const after = fs.readFileSync(bench.contentPath, 'utf8');
    expect(r.status === (weak ? 200 : 413), 'oversized content is refused with or without Content-Length after the fix');
    expect(weak ? after !== before : after === before, 'a refused oversized request leaves content byte-for-byte intact');
    results.push({ route: 'api/save', hasContentLength: length, ...r, changedDisk: after !== before });
  }
  const upload = await send('api/upload', JSON.stringify({ filename: 'synthetic.png', dataBase64: 'A'.repeat(7 * 1024 * 1024) }), { leaveOpen: true });
  expect(weak ? upload.status === null : upload.status === 413, 'an oversized chunked upload is refused before the client finishes sending');
  results.push({ route: 'api/upload', clientNeverFinishedBody: true, ...upload });
  const image = await send('api/upload', JSON.stringify({ filename: 'within-image-limit.png', dataBase64: Buffer.alloc(3 * 1024 * 1024).toString('base64') }));
  const storedImages = fs.readdirSync(path.join(bench.siteDir, 'images')).filter((name) => name.includes('within-image-limit'));
  expect(image.status === 200 && storedImages.some((name) => fs.statSync(path.join(bench.siteDir, 'images', name)).size === 3 * 1024 * 1024), 'the separate upload allowance accepts a complete image larger than the JSON content limit');
  results.push({ route: 'api/upload', validImageBytes: 3 * 1024 * 1024, ...image });
  const small = await send('api/save', JSON.stringify({ content: { hero: { headline: 'Small retry remains accepted', subhead: 'Whole small paragraph 🙂' } } }));
  expect(small.status === 200 && JSON.parse(fs.readFileSync(bench.contentPath, 'utf8')).hero.subhead === 'Whole small paragraph 🙂', 'server stays usable and saves a whole small retry');
  results.push({ route: 'api/save', smallRetry: true, ...small });
  note('Actual HTTP and disk read-backs', results);
  await page.goto(bench.url);
  await page.evaluate((results) => { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(results, null, 2); pre.style.whiteSpace = 'pre-wrap'; document.querySelector('main').prepend(pre); }, results);
  await step(weak ? 'dev accepts oversized content and waits for an unfinished upload' : 'dev refuses oversized streams promptly and preserves local content');
}
