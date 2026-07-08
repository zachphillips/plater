import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishSite } from '../packages/server-node/publish.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plater-publish-'));
  await fs.mkdir(path.join(dir, 'content/pages/projects'), { recursive: true });
  await fs.writeFile(path.join(dir, 'content/pages/index.md'), `---
title: Home
---
# Home

Welcome.
`);
  await fs.writeFile(path.join(dir, 'content/pages/about.md'), `---
title: About
permalink: /about-zach/
redirects:
  - /about/
  - /old-about/
---
# About

Flat page compatibility.
`);
  await fs.writeFile(path.join(dir, 'content/pages/projects/index.md'), `---
title: Projects
---
# Projects

Folder index.
`);
  await fs.writeFile(path.join(dir, 'content/pages/projects/alpha.md'), `---
title: Alpha
---
# Alpha

[plater-if logged-in]
Private project notes.
[/plater-if]
`);
  await fs.writeFile(path.join(dir, 'content/pages/projects/beta.html'), `<!doctype html>
<html>
<head>
<title>Ignored by metadata</title>
<script type="application/json" data-plater-meta>
{ "title": "Beta", "permalink": "/work/beta/", "redirects": ["/projects/beta/"] }
</script>
<meta name="plater:description" content="HTML metadata">
</head>
<body>
<h1>Beta</h1>
<p data-plater-if="logged-in">Logged-in HTML note.</p>
</body>
</html>
`);
  return dir;
}

test('publishes folders, indexes, slugs, markdown, and html pages', async () => {
  const dir = await fixture();
  const manifest = await publishSite({ cwd: dir });

  assert.deepEqual(manifest.pages.map((p) => p.route).sort(), [
    '/',
    '/about-zach/',
    '/projects/',
    '/projects/alpha/',
    '/work/beta/',
  ]);

  assert.match(await fs.readFile(path.join(dir, 'web/index.html'), 'utf8'), /<h1>Home<\/h1>/);
  assert.match(await fs.readFile(path.join(dir, 'web/projects/index.html'), 'utf8'), /Folder index/);
  assert.match(await fs.readFile(path.join(dir, 'web/projects/alpha/index.html'), 'utf8'), /Private project notes/);
  assert.match(await fs.readFile(path.join(dir, 'web/work/beta/index.html'), 'utf8'), /Logged-in HTML note/);
});

test('writes permalink redirects and flat content/pages compatibility redirects', async () => {
  const dir = await fixture();
  const manifest = await publishSite({ cwd: dir });

  assert.deepEqual(manifest.redirects.map((r) => `${r.from}->${r.to}`).sort(), [
    '/about/->/about-zach/',
    '/old-about/->/about-zach/',
    '/projects/beta/->/work/beta/',
  ]);
  assert.match(await fs.readFile(path.join(dir, 'web/about/index.html'), 'utf8'), /url=\/about-zach\//);
  assert.match(await fs.readFile(path.join(dir, 'web/old-about/index.html'), 'utf8'), /location\.replace\("\/about-zach\/"\)/);
  assert.match(await fs.readFile(path.join(dir, 'web/projects/beta/index.html'), 'utf8'), /url=\/work\/beta\//);
});

test('injects Plater conditional-content runtime without stripping markers', async () => {
  const dir = await fixture();
  await publishSite({ cwd: dir });

  const mdPage = await fs.readFile(path.join(dir, 'web/projects/alpha/index.html'), 'utf8');
  assert.match(mdPage, /data-plater-if="logged-in"/);
  assert.match(mdPage, /body\.plater-logged-in \[data-plater-if="logged-in"\]/);

  const htmlPage = await fs.readFile(path.join(dir, 'web/work/beta/index.html'), 'utf8');
  assert.match(htmlPage, /<title>Beta<\/title>/);
  assert.doesNotMatch(htmlPage, /data-plater-meta/);
  assert.doesNotMatch(htmlPage, /<!doctype html>[\s\S]*<!doctype html>/i);
  assert.match(htmlPage, /<meta name="description" content="HTML metadata">/);
  assert.match(htmlPage, /data-plater-if="logged-in"/);
});
