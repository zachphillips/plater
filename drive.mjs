import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ART = '/opt/cursor/artifacts';
fs.mkdirSync(ART, { recursive: true });

const bench = JSON.parse(fs.readFileSync(process.env.LIVE_AUTOSAVE_BENCH_FILE, 'utf8'));
const label = process.env.EXPORT_LABEL || 'run';
const expectWeak = process.env.MOBILE_STATUS_EXPECT_WEAK === '1';
const size = process.env.VIEWPORT || '390x844';
const [width, height] = size.split('x').map(Number);
const record = process.env.RECORD_VIDEO === '1';
const extraText = process.env.HEADLINE_TEXT || 'Phone writing stays safe when autosave is refused 🙂';
const refuseOnce = process.env.REFUSE_ONCE === '1';
const about = process.env.PAGE_PATH || '';
const doReload = process.env.RELOAD_AFTER === '1';
const doTwice = process.env.EDIT_TWICE === '1';

const result = {
  label, size, expectWeak, extraText, about, refuseOnce, doReload, doTwice,
  url: bench.url, startedAt: new Date().toISOString(),
};

function insideX(r, view) {
  return r.left >= view.left && r.right <= view.right;
}
function insideY(r, view) {
  return r.top >= view.top && r.bottom <= view.bottom;
}

const browser = await chromium.launch();
const contextOpts = { viewport: { width, height } };
const videoDir = path.join(ART, `video-tmp-${label}-${size}`);
if (record) {
  fs.mkdirSync(videoDir, { recursive: true });
  contextOpts.recordVideo = { dir: videoDir, size: { width, height } };
}
const context = await browser.newContext(contextOpts);
const page = await context.newPage();
const consoleErrors = [];
const failedRequests = [];
const responses = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/status of 503/.test(m.text())) consoleErrors.push(m.text());
});
page.on('requestfailed', (r) => {
  failedRequests.push({ url: r.url(), error: r.failure()?.errorText });
});
page.on('response', (r) => {
  if (r.status() >= 400) responses.push({ url: r.url(), status: r.status() });
});
page.on('dialog', (d) => d.accept(bench.editToken));

const target = bench.url.replace(/\/$/, '') + (about || '/') + '?edit&shot=1';
await page.goto(target);
await page.getByRole('button', { name: 'Edit page' }).click();

let refused = 0;
await page.route('**/api/save', async (route) => {
  if (refuseOnce && refused >= 1) return route.continue();
  refused += 1;
  return route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Synthetic temporary refusal' }),
  });
});

const h1 = page.locator('h1');
await h1.fill(extraText);
await page.waitForFunction(
  () => /retrying automatically/.test(document.querySelector('#cms-status')?.textContent || ''),
  null,
  { timeout: 15000 },
);
await page.waitForTimeout(250);

if (doTwice) {
  const second = extraText + ' again';
  await h1.fill(second);
  result.secondText = second;
  await page.waitForTimeout(2300);
  await page.waitForFunction(
    () => /retrying automatically/.test(document.querySelector('#cms-status')?.textContent || ''),
    null,
    { timeout: 15000 },
  );
}

const readContent = () => JSON.parse(fs.readFileSync(bench.contentPath, 'utf8'));
const storedHeadline = readContent().hero.headline;
const recovery = await page.evaluate((t) => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('plater.buf.'));
  return keys.map((k) => {
    const v = JSON.parse(localStorage.getItem(k));
    return { key: k, headline: v?.content?.hero?.headline, hasText: v?.content?.hero?.headline === t || String(v?.content?.hero?.headline || '').includes(t) };
  });
}, extraText);

const rects = await page.evaluate(() => {
  const vv = visualViewport;
  const view = {
    left: vv.offsetLeft,
    right: vv.offsetLeft + vv.width,
    top: vv.offsetTop,
    bottom: vv.offsetTop + vv.height,
    width: vv.width,
    height: vv.height,
    innerWidth: window.innerWidth,
  };
  const rect = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      tag: e.tagName,
      id: e.id,
      text: (e.textContent || '').slice(0, 240),
      name: e.getAttribute('aria-label') || e.name || e.id || (e.textContent || '').trim().slice(0, 40),
      hidden: e.hidden,
      display: cs.display,
      flexWrap: cs.flexWrap,
      flex: cs.flex,
      minWidth: cs.minWidth,
      overflowWrap: cs.overflowWrap,
      whiteSpace: cs.whiteSpace,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: r.width, height: r.height,
    };
  };
  const bar = document.querySelector('#cms-bar');
  return {
    view,
    bar: rect(bar),
    status: rect(document.querySelector('#cms-status')),
    buttons: [...document.querySelectorAll('#cms-bar button')]
      .filter((e) => e.getClientRects().length)
      .map(rect),
    allButtons: [...document.querySelectorAll('#cms-bar button')].map((e) => ({
      text: (e.textContent || '').trim(),
      hidden: e.hidden,
      display: getComputedStyle(e).display,
    })),
  };
});

const statusInsideX = rects.status ? insideX(rects.status, rects.view) : false;
const statusInsideY = rects.status ? insideY(rects.status, rects.view) : false;
const buttonsInside = (rects.buttons || []).every((b) => insideX(b, rects.view) && insideY(b, rects.view));
const statusVisibleText = (rects.status?.text || '');

const shotName = `${label}-${size}.png`;
await page.screenshot({ path: path.join(ART, shotName), fullPage: false });

if (doReload) {
  await page.reload();
  await page.waitForTimeout(800);
  result.afterReloadStatus = await page.locator('#cms-status').textContent().catch(() => null);
  result.afterReloadHeadline = await page.locator('h1').textContent();
  await page.screenshot({ path: path.join(ART, `${label}-after-reload-${size}.png`), fullPage: false });
}

result.storedHeadline = storedHeadline;
result.refusedHeadlineNeverCommitted = storedHeadline !== extraText && storedHeadline !== result.secondText;
result.recovery = recovery;
result.wholeWritingInRecovery = recovery.some((r) => r.hasText);
result.rects = rects;
result.statusInsideX = statusInsideX;
result.statusInsideY = statusInsideY;
result.buttonsInside = buttonsInside;
result.statusText = statusVisibleText;
result.consoleErrors = consoleErrors;
result.failedRequests = failedRequests.filter((r) => !/\/api\/save$/.test(r.url));
result.httpErrors = responses.filter((r) => r.status !== 503);
result.injected503Count = refused;
result.claims = {
  statusOnscreen: statusInsideX && statusInsideY,
  buttonsOnscreen: buttonsInside,
  contentUnchanged: result.refusedHeadlineNeverCommitted,
  recoveryKept: result.wholeWritingInRecovery,
};
result.passForThisRun = expectWeak
  ? !result.claims.statusOnscreen
  : result.claims.statusOnscreen && result.claims.buttonsOnscreen && result.claims.contentUnchanged && result.claims.recoveryKept;

const jsonName = `${label}-${size}.json`;
fs.writeFileSync(path.join(ART, jsonName), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  label, size, shotName, jsonName,
  statusInsideX, statusInsideY, buttonsInside,
  statusText: statusVisibleText,
  storedHeadline,
  refusedHeadlineNeverCommitted: result.refusedHeadlineNeverCommitted,
  wholeWritingInRecovery: result.wholeWritingInRecovery,
  passForThisRun: result.passForThisRun,
  consoleErrors: consoleErrors.length,
  barFlexWrap: rects.bar?.flexWrap,
  statusRight: rects.status?.right,
  viewRight: rects.view?.right,
}, null, 2));

await context.close();
await browser.close();

if (record) {
  const files = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (files[0]) {
    const dest = path.join(ART, `${label}-${size}.webm`);
    fs.renameSync(path.join(videoDir, files[0]), dest);
  }
  fs.rmSync(videoDir, { recursive: true, force: true });
}
