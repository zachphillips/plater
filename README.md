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
| `@plater/server-node` | Drop-in Vercel/Node handlers: `config.js`, `content.js`, `save.js` (commits merged content JSON to GitHub via the Contents API; auth = Google ID token or constant-time edit token). |
| `@plater/blog` | Collection content type: posts, permalink slugs, categories/tags, dates/drafts, RSS/sitemap. (zachphillips.blog) |
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
router-ui, blog, agent-bridge, and the Trapjaw host are in progress.

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
