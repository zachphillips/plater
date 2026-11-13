// A real OS write refusal must not destroy the last complete local content.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export async function journey({ page, step, expect, note }) {
  const bench = JSON.parse(fs.readFileSync(process.env.DISK_SAVE_BENCH_FILE, 'utf8'));
  const weak = Boolean(process.env.DISK_SAVE_EXPECT_WEAK);
  const results = [];
  const liveBefore = fs.readFileSync(bench.contentPath, 'utf8');
  const git = (...args) => execFileSync('git', ['-C', bench.siteDir, ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  fs.writeFileSync(bench.contentPath, JSON.stringify({ hero: { headline: 'Large history ' + 'x'.repeat(150000) } }));
  git('add', 'content/site.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic history for write refusal');
  const restore = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(bench.contentPath, liveBefore);
  const draftPath = path.join(path.dirname(bench.contentPath), 'versions', 'disk-proof', 'site.json');
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, JSON.stringify({ hero: { headline: 'Previous complete draft' } }));
  async function smallRetry() {
    const retry = await fetch(bench.url + 'api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: { hero: { headline: 'A small retry succeeds after the refusal' } } }) });
    expect(retry.status === 200 && JSON.parse(fs.readFileSync(bench.contentPath, 'utf8')).hero.headline === 'A small retry succeeds after the refusal', 'the next successful request still persists');
    note('Small retry', { status: retry.status });
  }
  for (const [name, target, track] of [['live', bench.contentPath, undefined], ['draft', draftPath, 'disk-proof'], ['history restore', bench.contentPath, undefined]]) {
    if (name === 'history restore') await smallRetry();
    const before = fs.readFileSync(target, 'utf8');
    const payload = name === 'history restore' ? { restore } : { content: { hero: { headline: 'Large content ' + 'x'.repeat(150000) } }, ...(track ? { track } : {}) };
    let r, response;
    try {
      r = await fetch(bench.url + (name === 'history restore' ? 'api/history' : 'api/save'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(7000) });
      response = await r.json();
    } catch (e) {
      expect(weak && name === 'history restore', 'only the original history failure closes the connection');
      r = { status: null };
      response = { error: 'connection closed during history write: ' + e.message };
    }
    const after = fs.readFileSync(target, 'utf8');
    let valid = true;
    try { JSON.parse(after); } catch { valid = false; }
    expect((weak && name === 'history restore' && r.status === null) || (r.status === 500 && response.error.includes('EFBIG')), 'the OS actually refused the file write');
    expect(weak ? after !== before && !valid : after === before && valid, name + ': failed writes preserve the last complete JSON');
    const leftovers = fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith('.plater-tmp'));
    if (!weak) expect(leftovers.length === 0, 'failed temporary writes are cleaned up');
    results.push({ name, status: r.status, error: response.error, previousBytes: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(after), previousContentPreserved: before === after, validJSON: valid, leftovers });
    if (weak) fs.writeFileSync(target, before); // restore this synthetic fixture after measuring the damage
  }
  if (!weak) await smallRetry();
  if (!weak) {
    const actual = bench.contentPath + '.actual';
    fs.renameSync(bench.contentPath, actual);
    fs.chmodSync(actual, 0o640);
    fs.symlinkSync(actual, bench.contentPath);
    try {
      await smallRetry();
      expect(fs.lstatSync(bench.contentPath).isSymbolicLink(), 'explicit content symlinks survive a successful save');
      expect((fs.statSync(actual).mode & 0o777) === 0o640, 'successful replacement preserves existing file permissions');
      note('Content symlink and permissions', { symlinkPreserved: true, mode: '0640' });
    } finally {
      fs.unlinkSync(bench.contentPath);
      fs.renameSync(actual, bench.contentPath);
    }
  }
  note('Real kernel EFBIG response and disk read-back (64 KiB file-size ceiling in bench child)', results);
  if (!weak) await page.goto(bench.url);
  await page.evaluate((rows) => { const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; p.textContent = rows.map((r) => `${r.name}: HTTP ${r.status} EFBIG, old content preserved=${r.previousContentPreserved}, valid JSON=${r.validJSON}, ${r.bytesAfter} bytes remain`).join('\n'); document.querySelector('main').prepend(p); }, results);
  await step(weak ? 'a refused disk write destroys the last saved JSON' : 'refused disk writes preserve complete live and draft content');
}
