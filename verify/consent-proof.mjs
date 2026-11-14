// The real capture -> unsubscribe -> scheduled repair path, with a temporary
// local mail or D1 refusal. No production data or mail is involved.
export async function journey({ page, step, expect, note }) {
  const base = process.env.CONSENT_PROOF_URL || 'http://127.0.0.1:24301';
  const weak = Boolean(process.env.CONSENT_EXPECT_WEAK);
  const email = `consent-${Date.now()}@example.com`;
  const state = async () => (await fetch(base + '/__bench/state')).json();
  const faults = (body) => fetch(base + '/__bench/faults', { method: 'POST', body: JSON.stringify(body) });
  const post = async (path, note) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example' }, body: JSON.stringify({ site: 'demo', email, ...(note ? { note } : {}) }) });
    expect(r.ok && (await r.json()).ok, path + ' honestly accepted');
  };
  const repair = async () => {
    await faults({});
    await fetch(base + '/__scheduled?cron=41+*+*+*+*');
    const end = Date.now() + 10000;
    for (;;) {
      const current = await state();
      if (!current.gaps.some((g) => g.value.sub.email === email)) return current.rows.find((r) => r.email === email);
      if (Date.now() > end) throw new Error('scheduled consent repair did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await faults({ relayFail: true });
  await post('/subscribe', 'First complete inquiry, before opting out.');
  const captured = await state();
  expect(captured.gaps.some((g) => g.value.sub.email === email), 'mail refusal left the real repair journal');
  await faults({});
  await post('/unsubscribe');
  const unsubscribed = (await state()).rows.find((r) => r.email === email).unsubscribed_at;
  expect(Boolean(unsubscribed), 'unsubscribe really reached D1');
  const repaired = await repair();
  expect(weak ? !repaired.unsubscribed_at : repaired.unsubscribed_at === unsubscribed, 'old repair must preserve a later opt-out');
  expect(repaired.note.includes('First complete inquiry'), 'inquiry is retained through repair');
  note('old repair after opt-out', { originallyUnsubscribedAt: unsubscribed, rowAfterRepair: repaired });
  await page.locator('#results').evaluate((el, data) => { el.textContent = JSON.stringify(data, null, 2); }, { unsubscribed, repaired });
  await step(weak ? 'old queued submission silently opts the address back in' : 'repair keeps the inquiry and the later opt-out');
  // A real new signup after opting out is new consent, even if D1 refuses it
  // at first. Keeping all repair inactive would incorrectly lose this consent.
  await post('/unsubscribe');
  await faults({ dbFail: true });
  await post('/subscribe', 'I have now chosen to subscribe again.');
  const resubscribed = await repair();
  expect(!resubscribed.unsubscribed_at && resubscribed.note.includes('I have now chosen to subscribe again.'), 'genuine newer signup is active after delayed D1 repair');
  note('newer consent repaired', resubscribed);
  await page.locator('#results').evaluate((el, data) => { el.textContent += '\nNew consent after opt-out:\n' + JSON.stringify(data, null, 2); }, resubscribed);
  await step('a genuinely newer signup still opts back in after repair');
}
