import test from 'node:test';
import assert from 'node:assert/strict';
import { rssXml, jsonFeed } from '../packages/server-node/feed.js';
import { matchRedirect, notFoundHtml } from '../packages/server-node/route.js';
import { llmsTxt } from '../packages/server-node/manifest.js';

const CONTENT = {
  meta: { title: 'Test Site', description: 'A site.', url: 'https://example.com' },
  feed: {
    title: 'Test Feed',
    items: [
      { id: 'https://example.com/one/', url: 'https://example.com/one/', title: 'One', description: 'First thing.', date: '2026-07-12T10:00:00-04:00' },
      { url: '/two/', title: 'Two (relative url, no date)' },
      { title: 'broken — no id or url' },
    ],
  },
  redirects: [
    { from: '/old/', to: '/new/', permanent: true },
    { from: '/away', to: 'https://other.example/x' },
    { from: '/evil/', to: 'javascript:alert(1)' },
  ],
  notFound: { title: 'Nope', body: 'Not here.', homeLabel: 'Home' },
};

test('rss: valid channel, RFC 822 pubDate, permalink guid, skips idless items', () => {
  const { body, problems } = rssXml(CONTENT, 'https://example.com/feed.xml');
  assert.match(body, /<rss version="2.0" xmlns:atom=/);
  assert.match(body, /<atom:link href="https:\/\/example.com\/feed.xml" rel="self"/);
  // RFC 822 with 4-digit year + GMT — the format readers actually accept
  assert.match(body, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
  assert.match(body, /<guid isPermaLink="true">https:\/\/example.com\/one\/<\/guid>/);
  // relative url resolved against meta.url
  assert.match(body, /<link>https:\/\/example.com\/two\/<\/link>/);
  // idless item skipped, surfaced as a problem, not a crash
  assert.ok(!body.includes('broken'));
  assert.ok(problems.some((p) => p.includes('missing id/url')));
});

test('json feed: 1.1 version, required id, RFC 3339 date_published passthrough', () => {
  const { body } = jsonFeed(CONTENT, 'https://example.com/feed.json');
  const feed = JSON.parse(body);
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(feed.items[0].id, 'https://example.com/one/');
  assert.equal(feed.items[0].date_published, '2026-07-12T10:00:00-04:00');
  assert.ok(feed.items.every((i) => i.id));
  assert.ok(feed.items.every((i) => 'content_text' in i));
});

test('feed order is curation order, not date order', () => {
  const { body } = jsonFeed(CONTENT, '');
  const feed = JSON.parse(body);
  assert.equal(feed.items[0].title, 'One');
  assert.equal(feed.items[1].title, 'Two (relative url, no date)');
});

test('redirects: permanent → 308, default → 302, normalized matching', () => {
  assert.deepEqual(matchRedirect(CONTENT, '/old/'), { to: '/new/', status: 308 });
  assert.deepEqual(matchRedirect(CONTENT, '/old'), { to: '/new/', status: 308 });
  assert.deepEqual(matchRedirect(CONTENT, '/OLD/'), { to: '/new/', status: 308 });
  assert.deepEqual(matchRedirect(CONTENT, '/away/'), { to: 'https://other.example/x', status: 302 });
  assert.equal(matchRedirect(CONTENT, '/nowhere/'), null);
});

test('redirects: unsafe schemes are ignored, never served', () => {
  assert.equal(matchRedirect(CONTENT, '/evil/'), null);
});

test('404 page: content-editable copy, escaped', () => {
  const html = notFoundHtml({ notFound: { title: '<b>x</b>' } });
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /name="robots" content="noindex"/);
});

test('llms.txt: H1 + summary + page and feed links', () => {
  const manifest = {
    site: 'test', url: 'https://example.com',
    pages: [{ path: '/', url: 'https://example.com/', title: 'Home', description: 'The front page.' }],
  };
  const txt = llmsTxt(manifest, CONTENT);
  assert.match(txt, /^# Test Site\n/);
  assert.match(txt, /> A site\./);
  assert.match(txt, /- \[Home\]\(https:\/\/example.com\/\): The front page\./);
  assert.match(txt, /## Curated feed/);
  assert.match(txt, /\/api\/manifest/);
});
