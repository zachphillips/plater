// Hidden spam fields can be autofilled. A refusal must never claim receipt.
export async function journey({ page, step, expect, note }) {
  const base = process.env.SPAM_PROOF_URL || 'http://127.0.0.1:24641';
  const weak = Boolean(process.env.SPAM_EXPECT_WEAK);
  const email = `autofill-${Date.now()}@example.com`;
  const post = async (company) => {
    const r = await fetch(base + '/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example' }, body: JSON.stringify({ site: 'demo', email, note: 'A complete real inquiry from an autofilled form 🙂', company }) });
    return { status: r.status, body: await r.json(), cors: r.headers.get('access-control-allow-origin') };
  };
  const rejected = await post('Autofilled company');
  const state = await (await fetch(base + '/__bench/state')).json();
  const stored = state.rows.some((r) => r.email === email);
  const journaled = state.gaps.some((r) => r.value.sub?.email === email);
  expect(!stored && !journaled, 'spam refusal persists no submission');
  expect(rejected.cors === 'https://demo.example', 'the browser can read the response');
  expect(weak ? rejected.status === 200 && rejected.body.ok : rejected.status === 422 && rejected.body.error && !rejected.body.ok, 'refusal must tell the visitor it was not received');
  note('Autofilled hidden field response and D1/KV read-back', { rejected, stored, journaled });
  await page.locator('#results').evaluate((el, data) => { el.textContent = JSON.stringify(data, null, 2); }, { rejected, stored, journaled });
  await step(weak ? 'false success with no copy of the inquiry' : 'explicit refusal lets the visitor use the email fallback');
  const accepted = await post('');
  const row = (await (await fetch(base + '/__bench/state')).json()).rows.find((r) => r.email === email);
  expect(accepted.status === 200 && accepted.body.ok && row?.note.includes('complete real inquiry'), 'clearing the hidden field retains normal complete capture');
  note('Corrected form really persisted', { accepted, row });
  await page.locator('#results').evaluate((el, data) => { el.textContent += '\nCorrected form:\n' + JSON.stringify(data, null, 2); }, { accepted, row });
  await step('a corrected form is accepted with its full inquiry');
}
