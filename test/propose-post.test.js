import test from 'node:test';
import assert from 'node:assert/strict';

import { safeDraftPath } from '../packages/server-node/propose-post.js';

test('propose-post accepts markdown drafts under the drafts prefix', () => {
  assert.equal(safeDraftPath('drafts/sherwood-post.md'), 'drafts/sherwood-post.md');
  assert.equal(safeDraftPath('/drafts/brigade-post.md'), 'drafts/brigade-post.md');
});

test('propose-post refuses traversal, non-markdown, and out-of-prefix paths', () => {
  assert.equal(safeDraftPath('drafts/../secrets.env'), null);
  assert.equal(safeDraftPath('../drafts/x.md'), null);
  assert.equal(safeDraftPath('drafts/note.txt'), null);
  assert.equal(safeDraftPath('content/site.json'), null);
  assert.equal(safeDraftPath('drafts\\win.md'), null);
  assert.equal(safeDraftPath(''), null);
});
