import test from 'node:test';
import assert from 'node:assert/strict';

// Set the shared edit token BEFORE the module is evaluated so verifyAuth can
// authenticate the handler test below via the constant-time token path (no
// network to Google). ESM `import` is hoisted, so a dynamic import after the
// assignment is required for the env to be read.
process.env.CMS_EDIT_TOKEN = 'test-edit-token';
const { default: handler, safeDraftPath, editView } = await import('../packages/server-node/propose-post.js');

function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

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

// --- security regression: URL-encoded path traversal / query truncation ------
// A value like `drafts/%2e%2e/README.md` or `drafts/file?x=.md` passed the naive
// check but, spliced into a GitHub Contents API URL, would percent-decode to
// `..` or truncate at `?` — escaping the drafts/ prefix and the .md restriction.
test('propose-post rejects URL metacharacters that escape the prefix in a GitHub URL', () => {
  assert.equal(safeDraftPath('drafts/%2e%2e/README.md'), null, 'percent-encoded dot-dot must be refused');
  assert.equal(safeDraftPath('drafts/file?x=.md'), null, 'query metacharacter must be refused');
  assert.equal(safeDraftPath('drafts/file#frag.md'), null, 'fragment metacharacter must be refused');
  assert.equal(safeDraftPath('drafts/%2f..%2fsecret.md'), null, 'encoded slash+traversal must be refused');
});

// --- security regression: prefix boundary is a true directory boundary -------
test('propose-post prefix is a real directory boundary, not a string prefix', () => {
  // `draftsX/…` must NOT be treated as under `drafts/`
  assert.equal(safeDraftPath('draftsX/post.md'), null);
  assert.equal(safeDraftPath('drafts-evil/post.md'), null);
});

// --- security regression: no <script> breakout via the path in editView ------
// safeDraftPath rejects angle brackets, but editView is exported and must
// escape '<' so a path can never break out of the inline <script> context.
test('editView escapes angle brackets so a path cannot break out of the inline script', () => {
  const evil = 'drafts/</script><script>alert(1)</script>x.md';
  const html = editView(evil);
  const scriptIdx = html.indexOf('const PATH=');
  const inlineTail = html.slice(scriptIdx, scriptIdx + 200);
  assert.ok(!inlineTail.includes('</script>'), 'inline PATH assignment must not contain a raw </script>');
  assert.ok(inlineTail.includes('\\u003c'), 'angle brackets must be unicode-escaped in the script context');
  assert.ok(!html.includes('<title>Draft — drafts/</script>'), 'title reflection must be HTML-escaped');
});

// --- stability regression: non-object JSON payloads must 400, not 500 --------
// `JSON.parse('null')` / 'true' / '42' parse successfully but leave a non-object
// payload; dereferencing payload.path would throw a TypeError -> unhandled 500.
test('POST with a non-object JSON body returns 400, not a 500', async () => {
  for (const raw of ['null', 'true', '42', '"a string"']) {
    const req = { method: 'POST', headers: { authorization: 'Bearer test-edit-token', 'content-length': String(raw.length) }, body: raw };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.code, 400, `body ${raw} must be a 400`);
  }
});

test('POST with a malformed JSON body returns 400', async () => {
  const req = { method: 'POST', headers: { authorization: 'Bearer test-edit-token', 'content-length': '3' }, body: '{ne' };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'invalid JSON body');
});
