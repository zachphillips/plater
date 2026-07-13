import test from 'node:test';
import assert from 'node:assert/strict';
import { slugForPage, pageForSlug, parseDraft, serializeDraft } from '../packages/server-node/versions.js';

test('slug round-trip: /, nested, .html', () => {
  assert.equal(slugForPage('/'), 'index');
  assert.equal(pageForSlug('index'), '/');
  assert.equal(slugForPage('/tools/phone/'), 'tools__phone');
  assert.equal(pageForSlug('tools__phone'), '/tools/phone/');
  assert.equal(slugForPage('/manifesto/your-computer.html'), 'manifesto__your-computer');
});

test('draft front matter round-trip', () => {
  const text = serializeDraft({ page: '/x/', source: 'gpt-5.6 high', generated_at: '2026-07-13' }, '# Title\n\nBody.');
  const { meta, body } = parseDraft(text);
  assert.equal(meta.source, 'gpt-5.6 high');
  assert.equal(body.trim(), '# Title\n\nBody.');
});

test('draft with no front matter parses as pure body', () => {
  const { meta, body } = parseDraft('just words');
  assert.deepEqual(meta, {});
  assert.equal(body, 'just words');
});
