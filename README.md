# Plater

A small, reusable **in-browser CMS + click-to-note agent-routing** module for the
Kitchen website fleet. Extracted from the Sherwood reference implementation so we
stop copy-pasting the same ~410 lines into every site.

## Why

Every fleet site re-implemented the same lightweight CMS by hand (inline
`contenteditable` editing, Google-SSO-or-edit-token auth, durable save via a
GitHub commit). Plater makes that a package you install, plus the new piece: click
any element, leave a note, and route it as a turn to a persistent coding agent
(on Trapjaw) that makes the change.

## Packages

| Package | What it is |
|---|---|
| `@plater/core` | Framework-free client editor: renders `site.json` via `data-bind`/`data-list`/`data-cards`/`data-links`, inline `contenteditable` editing, Google One Tap **or** shared edit-token auth, save to `/api/save`. |
| `@plater/server-node` | Drop-in Vercel/Node handlers: `config.js`, `content.js`, `save.js` (commits merged content JSON to GitHub via the Contents API; auth = Google ID token or constant-time edit token), plus the web-standards handlers: `feed.js`, `sitemap.js`, `route.js` (redirects + 404), `manifest.js` (agent manifest + llms.txt). |
| `@plater/capture` | Click → note → annotate overlay. Captures `{selector, outerHTML, nearby text, content-path, url, screenshot, note}`. Borrows the Impeccable capture UX. |
| `@plater/router-ui` | The per-note **chooser**: engine (Claude / Codex / local) × output (PR / push). |
| `@plater/agent-bridge` | Posts captured notes (authenticated) to the Trapjaw agent endpoint. |

## Install (static / Node site)

```bash
npm i @plater/core @plater/server-node
```

Then in the site's `api/`:

```js
// api/config.js
export { default } from '@plater/server-node/config';
// api/content.js
export { default } from '@plater/server-node/content';
// api/save.js
export { default } from '@plater/server-node/save';
// api/review.js  (edit-mode sitemap + per-page review state)
export { default } from '@plater/server-node/review';
// api/propose-post.js  (publishing-pipeline handoff: load a markdown draft by
// path, polish it in a minimal edit view, save back through the git-commit
// save path — agents draft, Zach edits, Zach publishes; no posting UI here)
export { default } from '@plater/server-node/propose-post';
```

For external consumers (e.g. the ibsky rail), alias the review status endpoint
in `vercel.json`:

```json
{ "rewrites": [{ "source": "/plater/review-status", "destination": "/api/review" }] }
```

And in the page:

```html
<script type="module">
  import { initPlater } from '@plater/core';
  initPlater({ brand: 'Sherwood' });
</script>
```

The CMS toolbar markup + `data-bind` attributes are unchanged from Sherwood — see
`examples/`.

## Environment (set in Vercel, not committed)

```
CMS_ADMIN_EMAIL      admin allowlist (e.g. zach@thekitchen.co)
CMS_EDIT_TOKEN       shared edit token (iPad-first fallback; never exposed)
GOOGLE_CLIENT_ID     Google SSO (optional; gates editability if set)
GITHUB_TOKEN         fine-grained PAT, contents:write
GITHUB_REPOSITORY    org/repo the CMS commits to
GITHUB_BRANCH        commit branch (default main)
GITHUB_EDIT_PATH     content path (default web/content/site.json)
CMS_SITE_NAME        short name used in commit messages
CMS_SITE_URL         absolute site origin — feeds + sitemap need it (falls back to site.json meta.url)
CMS_DEPLOY_HOOK      optional; only if not git-connected
ZMS_AGENT_ENDPOINT   Trapjaw agent host URL (for @plater/agent-bridge)
ZMS_AGENT_TOKEN      bearer secret for the agent host
PLATER_WEB_ROOT      static web root for page enumeration (default: web/, public/, .)
PLATER_REVIEW_PATH   review-state file path (default .plater-review.json)
PLATER_REVIEW_WEBHOOK  reviewWebhook: POSTed when the last unreviewed page is marked reviewed
```

## Deprecations

The old `zms` CLI command, `zms-core.js` / `zms-capture.js` vendored module paths,
`.zms-sync.json` sync manifest, `initZMS()` export, and `ZMS_WEB_ROOT` env var are
still accepted for existing sites. New installs and syncs use `plater`,
`plater-core.js` / `plater-capture.js`, `.plater-sync.json`, `initPlater()`, and
`PLATER_WEB_ROOT`.

## Review state (multi-page sites)

In `?edit` mode on a multi-page site, the editor shows a collapsible left
sitemap listing every page with a persistent "reviewed" checkbox. State lives
in `.plater-review.json` at the repo root, committed like any other Plater
save:

```json
{ "/about.html": { "reviewed_at": "<iso>", "by": "<email>", "content_hash": "<sha256>" } }
```

The hash covers the page's HTML plus the content values it binds, so a later
push or edit automatically flips the page back to unreviewed. `GET /api/review`
(alias `/plater/review-status`) reports per-page state + counts +
`fully_reviewed` for external queues.

Status: **0.1.0 — foundation.** Core + server extracted from Sherwood. Capture,
router-ui, agent-bridge, and the Trapjaw host are in progress.

## Web standards, agent-first (the philosophy, made mechanical)

Plater provides the plumbing every CMS owes the web — and **nothing that forces
a way of thinking**. No channels, no tags, no categories, no taxonomies, ever.
A "post" is just a page somebody put in the feed. Agents keep one-off pages
great; nothing has to match anything else.

- **`/feed.xml` + `/feed.json`** (`feed.js`) — the feed is **hand-curated
  content**, not a query. It serializes `site.json`'s `feed.items` array:
  `{ id, url, title, description, date }`. Edit it exactly the way you edit a
  page — same `/api/save`, same git commit, by hand or by agent. Reorder by
  reordering the array. Items may point at ANY url, including other sites.
  Dates are stored once as RFC 3339; the handler emits valid RFC 822 for RSS
  so nobody ever hand-writes the web's most-fumbled date format. Item `id`s
  are forever — readers dedupe on them.
- **`/sitemap.xml`** (`sitemap.js`) — from the same page enumeration the
  review checklist uses, so it can't disagree with the site. `lastmod` only
  when backed by a fresh review record (never a fabricated `now()`); no
  `changefreq`/`priority` (ignored by Google). Opt a page out via
  `site.json` `sitemap.exclude` or `<meta name="plater:sitemap" content="false">`.
- **Redirects-as-content + editable 404** (`route.js`) — `site.json`
  `redirects: [{ from, to, permanent }]`, live the moment the save deploys.
  The permalink law: renaming a URL means adding a redirect in the same
  change. 404 copy lives in `site.json` `notFound` and returns a real 404.
- **`/api/manifest` + `/llms.txt`** (`manifest.js`) — the site,
  machine-readable: every page, its bound content keys, review freshness, the
  feed, and a self-describing **write path** (how to save, how to send an
  agent note, the house laws). An agent that discovers a Plater site learns to
  edit it from this one GET. `?format=llms` renders the llms.txt convention.

Wire-up (vercel.json rewrites, after `plater sync`):

```json
{ "rewrites": [
  { "source": "/feed.xml",    "destination": "/api/feed?format=rss" },
  { "source": "/feed.json",   "destination": "/api/feed?format=json" },
  { "source": "/sitemap.xml", "destination": "/api/sitemap" },
  { "source": "/llms.txt",    "destination": "/api/manifest?format=llms" },
  { "source": "/(.*)",        "destination": "/api/route" }
] }
```

The catch-all MUST be last; Vercel serves real files first, so `route.js` only
sees misses. Give `api/feed.js`+`api/route.js` `includeFiles: web/content/**`
and `api/sitemap.js`+`api/manifest.js` `includeFiles: web/**`.

## Static publishing

`plater publish` builds a dependency-free static site from `content/pages/` into
`web/`. The content model follows the common static-generator baseline:

- folders become route groups, so `content/pages/projects/` maps to `/projects/`
- `index.md` or `index.html` owns the folder route
- other Markdown/HTML files become clean slugs, so `projects/sherwood.md` maps to
  `/projects/sherwood/`
- flat legacy sites such as `content/pages/about.md` still publish to `/about/`

Markdown pages use YAML front matter:

```md
---
title: About
permalink: /about-zach/
redirects:
  - /about/
---
# About
```

HTML pages use the equivalent metadata script, removed from the rendered output:

```html
<script type="application/json" data-plater-meta>
{ "title": "Beta", "permalink": "/work/beta/", "redirects": ["/projects/beta/"] }
</script>
<h1>Beta</h1>
```

`permalink` changes the canonical output route. The publisher automatically
writes redirect pages for the file's default route and every `redirects` or
`redirect_from` alias. That lets a `projects/` folder serve `/projects/` from its
index while child Markdown/HTML files become project slugs.

Plater-only conditional content is preserved with `data-plater-if="logged-in"`.
Markdown can emit it with:

```md
[plater-if logged-in]
Private notes for signed-in editors.
[/plater-if]
```

Generated pages include a tiny runtime that hides those blocks until Plater sees
an authenticated editor session and marks the page `plater-logged-in`.
