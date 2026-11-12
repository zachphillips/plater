// Data-loss guard for the sign-up list (packages/list-worker): a submission is
// answered "ok" only if at least one place (the D1 list, the email relay) has
// it, and when only one has it the gap is recorded for repair. A wrong answer
// here tells a visitor their inquiry was received when it is nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from '../packages/list-worker/capture.js';

const sub = { site: 'demo', email: 'someone@example.com', note: 'hello', created_at: '2026-11-11T00:00:00.000Z' };
const ok = async () => ({ fresh: true });
const refuse = async () => { throw new Error('refused'); };

for (const [db, relay, accepted] of [[ok, ok, true], [ok, refuse, true], [refuse, ok, true], [refuse, refuse, false]]) {
  test(`db ${db === ok ? 'takes' : 'refuses'}, relay ${relay === ok ? 'takes' : 'refuses'} → ${accepted ? 'ok' : 'not ok'}`, async () => {
    const gaps = [];
    const r = await capture(sub, { saveToDb: db, relay, recordGap: async (s, missing) => { gaps.push(missing); } });
    assert.equal(r.ok, accepted);
    const missing = [db === refuse && 'db', relay === refuse && 'relay'].filter(Boolean);
    assert.deepEqual(gaps, missing.length ? [missing] : [], 'a missing place is recorded, nothing else is');
  });
}

test('no relay configured: the database alone decides', async () => {
  assert.equal((await capture(sub, { saveToDb: ok })).ok, true);
  assert.equal((await capture(sub, { saveToDb: refuse })).ok, false);
});
