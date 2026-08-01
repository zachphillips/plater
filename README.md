# Plater

**Click an element on your live site, leave a note, and a coding agent opens the PR.**

Plater is a small, dependency-free CMS for static and Node sites. It has two halves
that reinforce each other:

1. **Inline editing that commits to git.** Add `data-bind` attributes to your HTML,
   put the values in `content/site.json`, and every page becomes editable in the
   browser. Every save is a real git commit through the GitHub Contents API — no
   database, no admin panel, no lock-in. Your content is a JSON file in your repo.
2. **Click-to-note agent routing.** Some changes aren't a word swap — they're
   "make this section two columns on mobile." For those, click the element, type
   the sentence, and Plater ships the element's selector, HTML, surrounding text,
   and page URL to a coding agent running against a checkout of your repo. The
   agent makes the change and opens a pull request.

Everything is plain ES modules and Node's standard library. Zero runtime
dependencies. No build step. No framework.

Plater was extracted from a reference implementation that had been copy-pasted
into several sites by hand; it's now the package instead of the copy-paste.

**→ [plater's site, with a live demo of the agent loop](https://zachphillips.github.io/plater/)**

---

## Table of contents

- [The 60-second version](#the-60-second-version)
- [How it works](#how-it-works)
- [Packages](#packages)
- [Install](#install)
- [Environment](#environment)
- [Local → staging → prod](#local--staging--prod-the-environment-ladder)
- [The agent loop](#the-agent-loop)
- [Design-alternatives mode](#design-alternatives-mode)
- [Versions (named drafts)](#versions-named-drafts)
- [Review state](#review-state-multi-page-sites)
- [Web standards, agent-first](#web-standards-agent-first)
- [Static publishing](#static-publishing)
- [Status and roadmap](#status-and-roadmap)
- [License](#license)

---

## The 60-second version

```bash
git clone https://github.com/zachphillips/plater
cd plater
npm run demo          # serves examples/static-site at http://127.0.0.1:4188
open 'http://127.0.0.1:4188/?edit'
```

Click any highlighted text, type over it, hit save. In dev the save writes
straight to `examples/static-site/content/site.json` on disk. In production the
same handler commits that file to your repo.

---

## How it works

### 1. Content is a JSON file; HTML declares what it binds

There is no template language and no build step. You write ordinary HTML and mark
the parts that are content:

```html
<h1 data-bind="home.hero.title">We build small, durable things.</h1>
<p  data-bind="home.hero.sub">One page at a time.</p>
<a  data-bind="home.cta.label" data-bind-attr="href:home.cta.url" href="/contact/">Get in touch</a>

<ul data-list="home.principles"></ul>
<div data-cards="work.projects"></div>
<nav data-links="footer.links"></nav>
```

```json
{
  "home": {
    "hero": { "title": "We build small, durable things.", "sub": "One page at a time." },
    "cta":  { "label": "Get in touch", "url": "/contact/" },
    "principles": ["Own your data", "Ship the small version", "Leave a redirect"]
  }
}
```

The HTML you author is the fallback: if `site.json` is missing a key, the page
still renders what's in the markup. That means the site is never blank, never
dependent on a fetch, and fully indexable before any JavaScript runs.

The five binding attributes:

| Attribute | Binds |
|---|---|
| `data-bind="a.b.c"` | element's text/HTML |
| `data-bind-attr="href:a.b.url, alt:a.b.alt"` | one or more attributes |
| `data-list="a.items"` | array of strings → `<li>` per item |
| `data-cards="a.projects"` | array of objects → one clone of a `<template>` per item; inside it, `data-field="title"`, `data-field-link="url"`, and `data-field-style="color:background"` map object keys onto text, `href`, and styles |
| `data-links="a.links"` | array of `{label, url}` → `<a>` per item |

### 2. Editing is `contenteditable` plus one POST

Add `?edit` to any URL. The editor (`@plater/core`) turns every bound element
into a `contenteditable` region, tracks the dirty ones, and on save POSTs a
**merge patch** — only the keys you changed — to `/api/save`.

### 3. Saving is a git commit

`/api/save` (from `@plater/server-node`) does exactly this:

1. Authenticate the caller (below).
2. `GET` the current `site.json` from the GitHub Contents API, with its blob sha.
3. Deep-merge the patch into it.
4. `PUT` it back with a commit message like `content: home.hero.title (via Plater)`.

That commit triggers your host's normal deploy. There is no separate publish
step, no cache to bust, no CMS database that can drift from the repo. `git log`
is the edit history. `git revert` is the undo button. If you delete Plater
entirely, your site keeps working — it's still just HTML plus a JSON file.

### 4. Auth: Google One Tap **or** a shared token

Two credentials, both checked server-side, both accepted by every write handler:

- **Google ID token** — verified against `oauth2.googleapis.com/tokeninfo`,
  checking `aud` against `GOOGLE_CLIENT_ID`, `email_verified`, expiry, and that
  the email equals `CMS_ADMIN_EMAIL`. With no `CMS_ADMIN_EMAIL` set the handlers
  **fail closed** — nobody is authorized until you say who is.
- **Shared edit token** — `CMS_EDIT_TOKEN`, compared with
  `crypto.timingSafeEqual`. This is the iPad-and-phone path: no OAuth popup, no
  cookies, just a token stored in `localStorage` after one prompt. If the server
  ever rejects a cached token, the editor clears it, re-prompts once, and retries.

The GitHub PAT never leaves the server. The browser has no repo access at any
point — it can only ask a handler you deployed to commit on its behalf.

### 5. Notes go to an agent, not to a backlog

When inline editing isn't enough, `@plater/capture` takes over. Click an element
and it captures:

```jsonc
{
  "selector": "main > section.work > div:nth-child(2)",
  "outerHTML": "<div class=\"card\">…</div>",      // trimmed
  "text": "nearby visible text for context",
  "contentPath": "work.projects",                   // if the element is bound
  "url": "https://example.com/work/",
  "rect": { "x": 24, "y": 880, "width": 640, "height": 320 }
}
```

You add a sentence, pick an engine (Claude / Codex / local) and an output (open a
PR / push directly), and it POSTs to **your own origin** at `/api/agent-note`.
That relay re-verifies your CMS credential, forces the `site` field to
`CMS_SITE_NAME` (so a caller can't aim a note at someone else's repo), and only
then forwards it to the agent host with a server-side bearer token the browser
never sees.

The agent host clones/pulls the site's repo, runs `claude -p …` or `codex exec …`
in that checkout, commits with a configurable identity, pushes a branch, and
opens a PR. **PR is the default** — a note produces something you review, not a
live deploy, unless a site is explicitly configured `output: "push"`.

---

## Packages

| Package | What it is |
|---|---|
| [`@plater/core`](packages/core) | The client editor. Renders `site.json` through `data-bind`/`data-list`/`data-cards`/`data-links`/`data-bind-attr`, adds inline `contenteditable` editing, Google-or-token auth, the save toolbar, the review sitemap rail, and the versions reader. ~750 lines, no dependencies. |
| [`@plater/server-node`](packages/server-node) | Twelve drop-in serverless handlers (Vercel-shaped `(req, res)`, fine on any Node server): `config`, `content`, `save`, `agent-note`, `review`, `versions`, `publish`, `propose-post`, `feed`, `sitemap`, `route`, `manifest`. |
| [`@plater/capture`](packages/capture) | The click-to-note overlay: element picker, note popover, engine × output chooser, and design mode. Imposes no fonts and no global styles on the host site. |
| [`@plater/agent-host`](packages/agent-host) | The long-running box that actually runs the agents. Bearer-gated, rate-limited, concurrency-capped, append-only audit journal, server-side site→repo allowlist. Designed to sit behind a Cloudflare Tunnel. |
| [`@plater/list-worker`](packages/list-worker) | Optional. A Cloudflare Worker + D1 email-capture backend shared across sites, to replace the `mailto:` stopgap. Captures, exports, deletes — no campaigns, no segments, no pixels. |

## Install

```bash
npm i @plater/core @plater/server-node
npx plater init .      # vendors the client modules + scaffolds api/ handlers
npx plater doctor .    # tells you exactly what's still unwired
```

`plater init` writes the handler shims for you; if you'd rather do it by hand,
each is a one-liner:

```js
// api/config.js
export { default } from '@plater/server-node/config';
// api/content.js
export { default } from '@plater/server-node/content';
// api/save.js
export { default } from '@plater/server-node/save';
// api/review.js       edit-mode sitemap + per-page review state
export { default } from '@plater/server-node/review';
// api/versions.js     named draft tracks
export { default } from '@plater/server-node/versions';
// api/agent-note.js   the click-to-note relay
export { default } from '@plater/server-node/agent-note';
// api/feed.js  api/sitemap.js  api/manifest.js  api/route.js
export { default } from '@plater/server-node/feed';
```

And in the page:

```html
<script type="module">
  import { initPlater } from '/plater-core.js';
  initPlater({ brand: 'Example' });
</script>
```

`examples/static-site/` is a complete working site — three pages, a `site.json`,
every binding attribute in use. `npm run demo` serves it.

## Environment

Set these on your host; commit none of them.

```
CMS_ADMIN_EMAIL      admin allowlist (e.g. you@example.com) — REQUIRED for Google auth
CMS_EDIT_TOKEN       shared edit token (phone/iPad path; never exposed to the client)
GOOGLE_CLIENT_ID     Google SSO client id (optional; gates editability if set)
GITHUB_TOKEN         fine-grained PAT, contents:write on the site repo
GITHUB_REPOSITORY    owner/repo the CMS commits to
GITHUB_BRANCH        commit branch (default main)
GITHUB_EDIT_PATH     content path (default web/content/site.json)
CMS_SITE_NAME        short name used in commit messages + forced on agent notes
CMS_SITE_URL         absolute site origin — feeds + sitemap need it
CMS_DEPLOY_HOOK      optional; only if your host isn't git-connected
ZMS_AGENT_ENDPOINT   agent host URL (for /api/agent-note)
ZMS_AGENT_TOKEN      bearer secret shared with the agent host
PLATER_WEB_ROOT      static web root for page enumeration (default: web/, public/, .)
PLATER_REVIEW_PATH   review-state file path (default .plater-review.json)
PLATER_REVIEW_WEBHOOK  POSTed when the last unreviewed page is marked reviewed
PLATER_GIT_NAME      git author name for agent commits (agent host)
PLATER_GIT_EMAIL     git author email for agent commits (agent host)
```

## Local → staging → prod (the environment ladder)

Three legs, one contract: the **same handlers** run everywhere, only the backing
store changes, so what you see locally is what deploys.

| Leg | Command | Editing | Saves go to | Agent notes |
|---|---|---|---|---|
| **local** | `plater dev <siteDir>` | `http://127.0.0.1:4188/?edit` — `devNoauth`, no token | the site's `site.json` **on disk** (commit when happy; `GITHUB_TOKEN` is force-unset) | disabled — echoed, never fired |
| **staging** | `git push origin <branch>` | the host's preview URL with `?edit` | commits to that branch via the normal save path | `output: pr` (the default) — every note lands as a reviewable PR |
| **prod** | merge to `main` | the live domain with `?edit` | commits to `main`, auto-deploys | `output: pr` reviewed, or `output: push` for trusted quick edits |

`plater dev` also serves `/feed.xml`, `/feed.json`, `/sitemap.xml`, `/llms.txt`,
`/api/manifest`, and the editable 404 — the full standards surface — so feed
curation and redirect edits are previewable before a single commit exists.

## The agent loop

Setting up the agent host is the one part that needs a machine you own. See
[`packages/agent-host/README.md`](packages/agent-host/README.md) for the full
walkthrough. In outline:

1. On a box you control (a spare Mac mini, a small VPS), check out each site's
   repo under `$ZMS_AGENT_WORKDIR` and describe them in `sites.json`
   (see [`sites.example.json`](packages/agent-host/sites.example.json)) — this
   server-side allowlist is what makes the client unable to target arbitrary repos.
2. Install the engines you want (`claude`, `codex`) and authenticate them once.
3. `export ZMS_AGENT_TOKEN=$(openssl rand -hex 32)` and start the host. It binds
   `127.0.0.1` only.
4. Expose it with a Cloudflare Tunnel (`deploy/setup-tunnel.sh`, requires
   `ZMS_AGENT_HOSTNAME`).
5. Set `ZMS_AGENT_ENDPOINT` + `ZMS_AGENT_TOKEN` on the *site's* host so
   `/api/agent-note` can reach it.

**Security model:** bearer token required on every mutating request
(constant-time compare); site→repo mapping is server-side; PR-by-default; rate
limited, concurrency-capped, append-only `jobs.jsonl` audit log. Because Codex
runs with sandboxing bypassed (bubblewrap needs user namespaces many hosts
disable), this host assumes a **trusted, single-tenant machine you own**. Don't
run it on shared hardware, and keep the bearer secret.

## Design-alternatives mode

Toggle **✦ Design** in the note popover and the loop inverts: instead of
describing a change in words, you get pictures first.

1. The host screenshots the live page with Playwright and locates the element's box.
2. It generates N distinct concept **images** of a redesign of that element
   (via `codex` image generation), each a different direction.
3. The images come back to the overlay, bearer-gated at `/design/:jobId/:n.png`.
4. You pick one. **The chosen image becomes the spec** — the coding agent is then
   told to implement the element to match the depicted design, with the note as
   secondary context.

No code is written until you've chosen a look.

## Versions (named drafts)

Git remembers every save; that's forensics, not editing. Versions are the
editorial layer: **named tracks** of whole alternate drafts, one file per page, at
`web/content/versions/<track>/<page-slug>.md` (`/` → `index`,
`/tools/phone/` → `tools__phone`).

A track exists as soon as a file is written — call it `opus`, `v2-launch`,
`shorter`, whatever. `GET /api/versions` lists tracks; `?track=t&page=/x/`
returns a draft; an authed POST writes one through the same git-commit path as
save. In `?edit` mode, pages with drafts show an `N✎` badge in the sitemap rail —
click it for a side-by-side reader of every track.

Two ways to use a draft:

- **Read and choose** — the drafts are documents; you apply a winner through the
  normal edit paths, never a blind overwrite.
- **Flip the live page onto it** — `?draft=<track>` renders the whole page from
  that track in place. Edits autosave to the draft, and **Make this live**
  promotes it (`{ promote: track }`) into `site.json` as a normal commit.

## Review state (multi-page sites)

In `?edit` mode on a multi-page site, the editor shows a collapsible left sitemap
listing every page with a persistent "reviewed" checkbox. State lives in
`.plater-review.json` at the repo root, committed like any other Plater save:

```json
{ "/about.html": { "reviewed_at": "<iso>", "by": "<email>", "content_hash": "<sha256>" } }
```

The hash covers the page's HTML **plus only the content keys that page binds**, so
a later push or edit automatically flips exactly the affected pages back to
unreviewed. `GET /api/review` (alias `/plater/review-status`) reports per-page
state, counts, and `fully_reviewed` for external dashboards.

## Web standards, agent-first

Plater ships the plumbing every CMS owes the web — and **nothing that forces a
way of thinking**. No channels, no tags, no categories, no taxonomies, ever. A
"post" is just a page somebody put in the feed. One-off pages stay great; nothing
has to match anything else.

- **`/feed.xml` + `/feed.json`** (`feed.js`) — the feed is **hand-curated
  content**, not a query. It serializes `site.json`'s `feed.items` array:
  `{ id, url, title, description, date }`. Edit it exactly the way you edit a
  page — same `/api/save`, same git commit, by hand or by agent. Reorder by
  reordering the array. Items may point at **any** URL, including other sites.
  Dates are stored once as RFC 3339; the handler emits valid RFC 822 for RSS so
  nobody hand-writes the web's most-fumbled date format. Item `id`s are forever —
  readers dedupe on them.
- **`/sitemap.xml`** (`sitemap.js`) — from the same page enumeration the review
  checklist uses, so it can't disagree with the site. `lastmod` **only** when
  backed by a real review record (never a fabricated `now()`); no
  `changefreq`/`priority` (Google ignores them). Opt a page out via `site.json`
  `sitemap.exclude` or `<meta name="plater:sitemap" content="false">`.
- **Redirects-as-content + editable 404** (`route.js`) — `site.json`
  `redirects: [{ from, to, permanent }]`, live the moment the save deploys. The
  permalink law: renaming a URL means adding a redirect in the same change. 404
  copy lives in `site.json` `notFound` and returns a real 404 status.
- **`/api/manifest` + `/llms.txt`** (`manifest.js`) — the site, machine-readable:
  every page, its bound content keys, review freshness, the feed, and a
  self-describing **write path** (how to save, how to send an agent note, the
  house rules). An agent that discovers a Plater site learns to edit it from this
  one GET, without ever reading Plater's source. `?format=llms` renders the
  llms.txt convention.

Wire-up (`vercel.json` rewrites, after `plater sync`):

```json
{ "rewrites": [
  { "source": "/feed.xml",    "destination": "/api/feed?format=rss" },
  { "source": "/feed.json",   "destination": "/api/feed?format=json" },
  { "source": "/sitemap.xml", "destination": "/api/sitemap" },
  { "source": "/llms.txt",    "destination": "/api/manifest?format=llms" },
  { "source": "/(.*)",        "destination": "/api/route" }
] }
```

The catch-all **must** be last; Vercel serves real files first, so `route.js` only
ever sees misses. Give `api/feed.js` + `api/route.js` `includeFiles:
web/content/**`, and `api/sitemap.js` + `api/manifest.js` `includeFiles: web/**`.

## Static publishing

`plater publish` builds a dependency-free static site from `content/pages/` into
`web/`. The content model follows the common static-generator baseline:

- folders become route groups, so `content/pages/projects/` maps to `/projects/`
- `index.md` or `index.html` owns the folder route
- other Markdown/HTML files become clean slugs, so `projects/atlas.md` maps to
  `/projects/atlas/`
- flat legacy sites such as `content/pages/about.md` still publish to `/about/`

Markdown pages use YAML front matter:

```md
---
title: About
permalink: /about-me/
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

`permalink` changes the canonical output route. The publisher automatically writes
redirect pages for the file's default route and for every `redirects` /
`redirect_from` alias.

Plater-only conditional content is preserved with `data-plater-if="logged-in"`:

```md
[plater-if logged-in]
Private notes for signed-in editors.
[/plater-if]
```

Generated pages include a tiny runtime that hides those blocks until Plater sees
an authenticated editor session and marks the page `plater-logged-in`.

## Status and roadmap

**Version 0.1.0.** Everything documented above is implemented and tested
(`npm test`, `npm run lint` — Node's own test runner and `node --check`; no
dev dependencies either). It runs several real sites. It has not yet run on
anyone else's, which is exactly what open-sourcing is for.

**Working today:** the editor and all five binding attributes · git-commit save
with Google-or-token auth · `plater dev` local leg · click-to-note capture,
relay, and agent host (PR-by-default) · design-alternatives mode · versions,
`?draft=` flipping, and promote · review state with content hashing · feeds,
sitemap, redirects, editable 404, manifest, llms.txt · static publishing ·
optional email-capture worker.

**Known gaps and next steps:**

- **Nothing is published to npm yet.** The install instructions describe the
  intended shape; today you consume Plater by vendoring (`plater init` / `plater
  sync`) from a checkout. Publishing the three client-facing packages is the next
  release task.
- **The agent host is one machine.** It's deliberately single-tenant and trusted.
  Multi-user, per-user credentials, and real sandboxing are unbuilt. Treat the
  bearer token as the whole security boundary.
- **Design mode depends on locally installed tooling** (Playwright, `codex` with
  image generation). There's no fallback when they're absent beyond an error status.
- **Google auth is single-admin.** `CMS_ADMIN_EMAIL` is one address, not a list.
  Multiple editors currently share the edit token.
- **`?edit` is client-side gated for *editability*, not for content secrecy.**
  Everything in `site.json` is public by definition — it's served to the browser.
  `data-plater-if="logged-in"` hides, it does not protect.
- **Vercel-shaped handlers.** They're plain `(req, res)` functions and `plater
  dev` runs them on a bare `node:http` server, but the documented rewrites are
  Vercel's. Cloudflare Pages and Netlify equivalents aren't written down yet.
- **The CLI still answers to `zms`** and vendors `zms-core.js` shims. Deprecated,
  kept for existing sites, to be removed at 1.0.
- **Tests cover the server seams**, not the browser. There's no headless test of
  the editor overlay itself.

Deprecations: the old `zms` command, `zms-core.js` / `zms-capture.js` vendored
paths, `.zms-sync.json`, `initZMS()`, and `ZMS_WEB_ROOT` are still accepted. New
installs use `plater`, `plater-core.js` / `plater-capture.js`, `.plater-sync.json`,
`initPlater()`, and `PLATER_WEB_ROOT`.

## Contributing

Issues and PRs welcome. The bar is the same as the codebase: no runtime
dependencies, no build step, no framework. `npm test` and `npm run lint` must
pass — CI runs both on Node 20 and 22.

## License

MIT — see [LICENSE](LICENSE).
