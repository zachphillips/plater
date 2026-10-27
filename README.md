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
It ships on npm as **platercms** (`@platercms/core`, `@platercms/server-node`,
`@platercms/capture`, CLI `platercms`); the repo is `zachphillips/plater`.

**→ [plater's site, with a live demo of the agent loop](https://zachphillips.github.io/plater/)**

---

## Table of contents

- [The 60-second version](#the-60-second-version)
- [How it works](#how-it-works)
- [Packages](#packages)
- [Install](#install)
- [Environment](#environment)
- [Local → staging → prod](#local--staging--prod-the-environment-ladder)
- [Self-hosting: `platercms serve`](#self-hosting-platercms-serve)
- [The agent loop](#the-agent-loop)
- [Design-alternatives mode](#design-alternatives-mode)
- [Versions (named drafts)](#versions-named-drafts)
- [Review state and the Pages rail](#review-state-and-the-pages-rail-multi-page-sites)
- [Web standards, agent-first](#web-standards-agent-first)
- [Static publishing](#static-publishing)
- [Status and roadmap](#status-and-roadmap)
- [License](#license)

---

## The 60-second version

```bash
npm create platercms@latest my-site
cd my-site
npx platercms dev .          # http://127.0.0.1:4188
open 'http://127.0.0.1:4188/?edit'
```

You get a site that already renders — hand-written HTML, one CSS file, all the
copy in `content/site.json` — plus the vendored client editor and the `api/`
handlers. Click any highlighted text, type over it, hit save. In dev the save
writes straight to `content/site.json` on disk (`GITHUB_TOKEN` is force-unset,
so a local session can never commit). In production the same handler commits
that file to your repo.

Prefer to read before you install? `git clone` this repo and run `npm run demo`
— it serves `examples/static-site` on the same port.

---

## How it works

### 1. Content is a JSON file; HTML declares what it binds

There is no template language and no build step. You write ordinary HTML and mark
the parts that are content:

```html
<h1 data-bind="home.hero.title">We build small, durable things.</h1>
<p  data-bind="home.hero.sub">One page at a time.</p>
<a  data-bind="home.cta.label" data-bind-attr="home.cta.url:href" href="/contact/">Get in touch</a>

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
| `data-bind="a.b.c"` | element's text |
| `data-bind-attr="a.b.url:href"` | one attribute, written `contentPath:attribute` (works in `<head>` too, so canonical and OG tags are content) |
| `data-list="a.items"` | array of strings → one `data-list-tag` element (default `<p>`) per item |
| `data-cards="a.projects"` | array of objects → one clone of a `<template>` per item; inside it, `data-field="title"`, `data-field-link="url"`, and `data-field-style="color:background"` map object keys onto text, `href`, and styles |
| `data-links="a.links"` | array of `{label, href}` → `<a>` per item |

**Per-page content files.** One `site.json` stops scaling on a big site, so
`/api/content?file=pricing.json` serves any other JSON sitting in the content
directory. The path is resolved against that directory and must end in `.json`;
traversal, absolute paths, and symlinks pointing outside it are refused with a
400, and a missing file is an honest 404 rather than a silently blank page.

### 2. Editing is `contenteditable` plus one POST

Add `?edit` to any URL (or press Cmd/Ctrl+E). The editor (`@platercms/core`)
turns every bound element into a `contenteditable` region, tracks the dirty
ones, and on save POSTs the content to `/api/save`. Around that core loop:

- **Arrays are editable as arrays.** Every `data-list` / `data-cards` container
  gets per-item **×** / **↑** / **↓** and one **+ Add** in edit mode. A new card
  takes its shape from the `<template>` (link fields stay empty, so nothing
  renders a dead `href`), and the caret lands in the new item's first field. All
  of that chrome carries a marker attribute: it's stripped from collected text,
  hidden by CSS outside edit mode, and deleted outright when editing ends, so it
  can never reach `site.json`.
- **Image replace.** In edit mode an `<img>` whose `src` is bound to content
  shows a **⤢ Replace image** chip on hover and accepts a dropped file. The file
  goes to `/api/upload`, which commits it to the repo (PNG/JPG/GIF/WebP/SVG, 4 MB
  cap, name prefixed with 8 hex chars of its content hash so two `photo.jpg`s
  can't collide) and returns a site-relative URL. Only the URL lands in
  `CONTENT`, so the swap rides your next Save like any other edit.
- **Plain-text paste.** Bindings hold strings, not markup. Pasting from a word
  processor or another page inserts `text/plain` only, flattened to one line;
  dropping HTML into a binding is refused outright.
- **A crash buffer, and a guard on the way out.** Debounced snapshots of
  unsaved edits go to `localStorage`, keyed per page and per draft track, and are
  offered back — **Restore** / **Discard** — the next time you enter edit mode.
  Nothing is applied without a click, and any save or cancel clears it. On top of
  that, `beforeunload` warns you only when you have actually typed something that
  still differs from the last save.

### 3. Saving is a git commit

`/api/save` (from `@platercms/server-node`) does exactly this:

1. Authenticate the caller (below).
2. `GET` the current `site.json` from the GitHub Contents API, with its blob sha.
3. Merge the posted top-level keys into it.
4. `PUT` it back with a commit message like `content(<site>): edit via CMS by <you>`.

That commit triggers your host's normal deploy. There is no separate publish
step, no cache to bust, no CMS database that can drift from the repo. `git log`
is the edit history. `git revert` is the undo button. If you delete Plater
entirely, your site keeps working — it's still just HTML plus a JSON file.

**Conflicts are merged, never lost.** Two people (or a person and an agent) can
commit between your load and your Save. The handler refetches and retries once
server-side; a second collision is reported honestly as `409 { error: 'conflict' }`
rather than resolved by clobbering someone. The editor answers that 409 by
fetching the winner's file, replaying **only the fields this session changed** on
top of it, and handing the page back still in edit mode with a plain-English
line: *"Someone else saved while you were editing — reloaded the latest, your
edits are kept (3 fields). Review and Save again."* Arrays are replayed whole
rather than reconciled item by item, because guessing there silently eats work.

**History, and one-click restore.** Every save being a commit means undo already
exists; the **⟲ History** button in the edit bar is the editor's window onto it.
`GET /api/history` lists the last N commits that touched the content file
(authenticated exactly like a write — commit metadata carries author emails), and
**Restore** writes an old version back **as a new commit**. Nothing is
force-pushed and nothing is reverted, so the timeline only ever grows and you can
restore your way back out again.

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

**The first-visit checklist.** A site with neither credential configured can't
let anybody in, which used to mean `?edit` showed a sign-in button that did
nothing. Now it shows a setup panel instead: the same env checklist
`platercms doctor` prints, one line each, required keys first, with a direct link
to mint the fine-grained GitHub PAT. It is the last step of an install, addressed
to the person who can finish it — not an error.

### 5. Notes go to an agent, not to a backlog

When inline editing isn't enough, `@platercms/capture` takes over. Click an element
and it captures:

```jsonc
{
  "selector": "main > section.work > div:nth-child(2)",
  "outerHTML": "<div class=\"card\">…</div>",      // trimmed
  "text": "nearby visible text for context",
  "contentPath": "work.projects",                   // if the element is bound
  "url": "https://example.com/work/",
  "rect": { "top": 880, "left": 24, "width": 640, "height": 320 }
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

**The notes tray** answers the question a fire-and-forget note used to leave
hanging: *did that land?* Every note you send is logged in this browser
(`localStorage`, a receipt book — not state the server owes anyone) and shown in
a **Notes** pane with its live status, its age, the bound content path, and a
link to the PR when one exists. Open jobs are polled every 10s while the tray is
open and never while it's closed; each job is polled independently, so one dead
job can't stall the rest and a network blip is never reported as a failure.

---

## Packages

| Package | What it is |
|---|---|
| [`platercms`](cli) | The CLI, and the only package carrying the `platercms` bin — `init`, `dev`, `serve`, `doctor`, `sync`, `publish`. This is what `npx platercms` resolves to. Ships the starter template and the handler sources it scaffolds from, so `init` works straight out of the tarball. |
| [`@platercms/core`](packages/core) | The client editor. Renders `site.json` through `data-bind`/`data-list`/`data-cards`/`data-links`/`data-bind-attr`, adds inline `contenteditable` editing, array controls, image replace, the crash buffer, conflict merge, the History panel, the page-meta editor, Google-or-token auth, the save toolbar, the review sitemap rail, and the drafts reader. ~1,850 lines, no dependencies. |
| [`@platercms/server-node`](packages/server-node) | Thirteen drop-in serverless handlers (Vercel-shaped `(req, res)`, fine on any Node server): `config`, `content`, `save`, `history`, `upload`, `agent-note`, `review`, `versions`, `feed`, `sitemap`, `route`, `manifest`, `propose-post` — plus `publishSite()`, the static publisher behind `platercms publish`. |
| [`@platercms/capture`](packages/capture) | The click-to-note overlay: element picker, note popover, engine × output chooser, notes tray, and design mode. Imposes no fonts and no global styles on the host site. |
| [`create-platercms`](packages/create-platercms) | `npm create platercms@latest my-site` — scaffolds a running site: the starter page, the vendored client modules, and the `api/` handlers. Its payload is refilled from this repo on `prepack`, so a published tarball can never carry a stale fork of the editor. |
| [`@platercms/agent-host`](packages/agent-host) | The long-running box that actually runs the agents. Bearer-gated, rate-limited, concurrency-capped, append-only audit journal, server-side site→repo allowlist. Designed to sit behind a Cloudflare Tunnel. Deployed, not published. |
| [`@platercms/list-worker`](packages/list-worker) | Optional. A Cloudflare Worker + D1 email-capture backend shared across sites, to replace the `mailto:` stopgap. Captures, exports, deletes — no campaigns, no segments, no pixels. Deployed with wrangler, not published. |

## Install

Three doors, depending on what you already have.

**A new site** — the front door:

```bash
npm create platercms@latest my-site
cd my-site && npx platercms dev .
```

**A site you already have** — `init` finds your web root (`web/`, `public/`, else
the project root), keeps every file that is already there, and prints each skip.
The two vendored client modules are the exception: they are always refreshed,
because you never hand-edit them.

```bash
npx platercms init .      # starter files you're missing + vendored client + api/ handlers
npx platercms doctor .    # tells you exactly what's still unwired
```

**Just curious** — read it before you install anything:

```bash
git clone https://github.com/zachphillips/plater
cd plater && npm run demo          # examples/static-site at http://127.0.0.1:4188
```

**Deploy with Vercel** — `platercms init` writes the `vercel.json` rewrites for
you, so any of the three doors above is `git push` + import + set the environment
variables away from an editable site on your own domain.

> The npm packages publish from a `v*` tag via
> [`.github/workflows/release.yml`](.github/workflows/release.yml) (tests gate the
> publish; `--provenance`; an already-published version is skipped, not failed).
> Until that first tag ships, use the `git clone` route. A one-click
> `platercms-starter` repo (deploy button, no terminal at all) is planned for
> after that tag, not published — see [Status](#status-and-roadmap).

`platercms init` writes the handler shims for you; if you'd rather consume the
packages directly, every shim is a whole file whose entire contents are one line
— `api/<name>.js` re-exporting `@platercms/server-node/<name>`. The thirteen are
below (this listing is thirteen separate files, not one module):

```
api/config.js       export { default } from '@platercms/server-node/config';
api/content.js      export { default } from '@platercms/server-node/content';
api/save.js         export { default } from '@platercms/server-node/save';
api/history.js      export { default } from '@platercms/server-node/history';      past saves + restore-as-a-new-commit
api/upload.js       export { default } from '@platercms/server-node/upload';       image uploads, committed to the repo
api/review.js       export { default } from '@platercms/server-node/review';       edit-mode sitemap + per-page review state
api/versions.js     export { default } from '@platercms/server-node/versions';     named draft tracks
api/agent-note.js   export { default } from '@platercms/server-node/agent-note';   the click-to-note relay
api/propose-post.js export { default } from '@platercms/server-node/propose-post'; agent-proposed posts, PR by default
api/feed.js         export { default } from '@platercms/server-node/feed';         /feed.xml + /feed.json
api/sitemap.js      export { default } from '@platercms/server-node/sitemap';      /sitemap.xml + /llms.txt
api/manifest.js     export { default } from '@platercms/server-node/manifest';     the site's own capability manifest
api/route.js        export { default } from '@platercms/server-node/route';        redirects + the editable 404
```

And in the page:

```html
<script type="module">
  import { initPlater } from '/plater-core.js';
  initPlater({ brand: 'Example' });
</script>
```

`templates/starter/` is the site `init` and `npm create` scaffold from;
`examples/static-site/` is a complete working site — three pages, a `site.json`,
every binding attribute in use. `npm run demo` serves it. Step-by-step wiring for
an existing site: [`docs/GUIDE.md`](docs/GUIDE.md).

## Environment

Set these on your host; commit none of them. `platercms serve` will also read
them from a `.env` beside the site (the host always wins).

```
CMS_ADMIN_EMAIL      admin allowlist (e.g. you@example.com) — REQUIRED for Google auth
CMS_EDIT_TOKEN       shared edit token (phone/iPad path; never exposed to the client)
GOOGLE_CLIENT_ID     Google SSO client id (optional; gates editability if set)
GITHUB_TOKEN         fine-grained PAT, contents:write on the site repo
GITHUB_REPOSITORY    owner/repo the CMS commits to
GITHUB_BRANCH        commit branch (default main)
GITHUB_EDIT_PATH     content path (default web/content/site.json)
PLATER_IMAGES_DIR    repo path /api/upload commits images to (default: images/ in the web root)
CMS_SITE_NAME        short name used in commit messages + forced on agent notes
CMS_SITE_URL         absolute site origin — feeds + sitemap need it
CMS_DEPLOY_HOOK      optional; only if your host isn't git-connected
PLATER_AGENT_ENDPOINT  agent host URL (for /api/agent-note)
PLATER_AGENT_TOKEN     bearer secret shared with the agent host
PLATER_WEB_ROOT      static web root for page enumeration (default: web/, public/, .)
PLATER_REVIEW_PATH   review-state file path (default .plater-review.json)
PLATER_REVIEW_WEBHOOK  POSTed when the last unreviewed page is marked reviewed
PLATER_GIT_NAME      git author name for agent commits (agent host)
PLATER_GIT_EMAIL     git author email for agent commits (agent host)
```

## Google sign-in setup

Create a Google OAuth web client in Google Cloud Console → APIs & Services →
Credentials → Create credentials → OAuth client ID → Web application. Configure
the consent screen first if Google requests it, including permitted test users
while the app is in testing.

Add every site's exact HTTPS origin under Authorized JavaScript origins, for
example `https://greatrebellion.net`, `https://sherwood.thekitchen.co`,
`https://thekitchen.co`, `https://liz.thekitchen.co`, and
`https://thepantry.thekitchen.co`. Include any custom domains used for editing.
Set both `GOOGLE_CLIENT_ID` and `CMS_ADMIN_EMAIL` in each site's Vercel
environment, selecting Production and any Preview environments that need it,
then redeploy those environments so `/api/config` picks up the changes.

`CMS_EDIT_TOKEN` can stay configured as fallback when Google sign-in cannot
complete. Credentials persist with an explicit kind across pages and visits;
Google ID tokens refresh through GIS when possible. One Tap may require
interaction or be suppressed by browser policy, so this is best-effort renewal,
not a server-backed refresh session. Old credentials without kind metadata
require one sign-in again when Google is configured.

## Local → staging → prod (the environment ladder)

Four legs, one contract: the **same handlers** run everywhere, only the backing
store changes, so what you see locally is what deploys.

| Leg | Command | Editing | Saves go to | Agent notes |
|---|---|---|---|---|
| **local** | `platercms dev <siteDir>` | `http://127.0.0.1:4188/?edit` — `devNoauth`, no token | the site's `site.json` **on disk** (commit when happy; `GITHUB_TOKEN` is force-unset) | disabled — echoed, never fired |
| **staging** | `git push origin <branch>` | the host's preview URL with `?edit` | commits to that branch via the normal save path | `output: pr` (the default) — every note lands as a reviewable PR |
| **prod (Vercel)** | merge to `main` | the live domain with `?edit` | commits to `main`, auto-deploys | `output: pr` reviewed, or `output: push` for trusted quick edits |
| **prod (self-host)** | `platercms serve <siteDir>` | the domain you point at it, with `?edit` | commits to `GITHUB_BRANCH`, exactly as on Vercel | same as Vercel — the relay is the same handler |

`platercms dev` also serves `/feed.xml`, `/feed.json`, `/sitemap.xml`,
`/llms.txt`, `/api/manifest`, and the editable 404 — the full standards surface —
so feed curation and redirect edits are previewable before a single commit
exists. `/api/history` there reads real `git log` of the content file, and
Restore rewrites it on disk; `/api/upload` writes into the web root's `images/`.

**Port autopick.** Both `dev` (default 4188) and `serve` (default 8080) walk
upward from their port on `EADDRINUSE` and print the port they actually took, so
a second site never fails to start. `PORT=<n>` picks the starting point; every
port in the range being busy is one human line, not a stack trace.

## Self-hosting: `platercms serve`

`platercms dev` is the local leg — no auth, saves are file writes. `platercms
serve` is the **production** leg for anyone not on Vercel: a plain Node host, a
VPS, a container, a Tailscale box. Same handlers, same routes, and the rewrites
served by hand — `/feed.xml`, `/feed.json`, `/sitemap.xml`, `/llms.txt`,
`/.well-known/plater.json`, `/plater/review-status`, redirects and the editable
404 — so a Node host and a Vercel deployment of the same directory behave
identically.

Nothing is relaxed for convenience:

- **Auth is real.** Every write needs `CMS_EDIT_TOKEN` or a Google ID token, and
  fails closed when neither is configured — the site simply serves read-only.
- **Saves still commit** to GitHub through `GITHUB_TOKEN`, exactly as on Vercel.
- **Config comes from `process.env` first, then `KEY=VALUE` lines from
  `<siteDir>/.env`** for hosts with no env UI. The host always wins, so a stale
  `.env` can never override it, and only key *names* are ever logged.
- **Binding is deliberate.** `HOST` defaults to `127.0.0.1` (put TLS in front, or
  set `0.0.0.0` on purpose), `PORT` to 8080.
- **Dotfiles are never assets.** A flat site's web root *is* the project dir, so
  `.env`, `.git/` and `.plater-review.json` sit under it; those paths fall
  through to the ordinary 404 rather than a 403, which would confirm they exist.
  `.well-known` is the one exception, for ACME.

```bash
CMS_EDIT_TOKEN=$(openssl rand -hex 32) npx platercms serve .
```

## The agent loop

Setting up the agent host is the one part that needs a machine you own. See
[`packages/agent-host/README.md`](packages/agent-host/README.md) for the full
walkthrough. In outline:

1. On a box you control (a spare Mac mini, a small VPS), check out each site's
   repo under `$PLATER_AGENT_WORKDIR` and describe them in `sites.json`
   (see [`sites.example.json`](packages/agent-host/sites.example.json)) — this
   server-side allowlist is what makes the client unable to target arbitrary repos.
2. Install the engines you want (`claude`, `codex`) and authenticate them once.
3. `export PLATER_AGENT_TOKEN=$(openssl rand -hex 32)` and start the host. It binds
   `127.0.0.1` only.
4. Expose it with a Cloudflare Tunnel (`deploy/setup-tunnel.sh`, requires
   `PLATER_AGENT_HOSTNAME`).
5. Set `PLATER_AGENT_ENDPOINT` + `PLATER_AGENT_TOKEN` on the *site's* host so
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
  that track in place. Editing switches on the moment you arrive with a
  credential (viewing a draft *is* editing it), every change autosaves to the
  track's overlay two seconds after
  you stop typing — with the same conflict merge the manual Save path uses — and
  **⬆ Make this live** promotes it (`{ promote: track }`) into `site.json` as one
  normal commit. **+ New draft** starts a track by naming it; there is no registry
  to register with.

## Review state and the Pages rail (multi-page sites)

In `?edit` mode on a site with more than one page, the editor shows a collapsible
left rail listing every page with a persistent "reviewed" checkbox — and while
that rail is open, **r** ticks the page you're on. State lives in
`.plater-review.json` at the repo root, committed like any other Plater save:

```json
{ "/about.html": { "reviewed_at": "<iso>", "by": "<email>", "content_hash": "<sha256>" } }
```

The hash covers the page's HTML **plus only the content keys that page binds**, so
a later push or edit automatically flips exactly the affected pages back to
unreviewed. `GET /api/review` (alias `/plater/review-status`) reports per-page
state, counts, and `fully_reviewed` for external dashboards.

**The meta editor** lives at the foot of that rail: four inputs — title,
description, site URL, share image — writing straight into `content.meta`. It is
the part of a page nobody sees and everybody reads (the browser tab, the search
snippet, the share card), so it has no place *on* the page. The fields are
dirty-tracked exactly like inline text, so the same Save commits them, and
emptying one removes the key rather than committing an empty string.

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
  llms.txt convention; `/.well-known/plater.json` is the same document.

Wire-up (`vercel.json` rewrites, as `platercms init` writes them):

```json
{ "rewrites": [
  { "source": "/feed.xml",    "destination": "/api/feed?format=rss" },
  { "source": "/feed.json",   "destination": "/api/feed?format=json" },
  { "source": "/sitemap.xml", "destination": "/api/sitemap" },
  { "source": "/llms.txt",    "destination": "/api/manifest?format=llms" },
  { "source": "/.well-known/plater.json", "destination": "/api/manifest" },
  { "source": "/(.*)",        "destination": "/api/route" }
] }
```

The catch-all **must** be last; Vercel serves real files first, so `route.js` only
ever sees misses. Give `api/feed.js` + `api/route.js` `includeFiles:
content/**`, and `api/sitemap.js` + `api/manifest.js` `includeFiles:
{content/**,**/*.html}` (adjust the prefix if your content lives under `web/`).

## Static publishing

`platercms publish` builds a dependency-free static site from `content/pages/`
into `web/`. The content model follows the common static-generator baseline:

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

**Working today:** the editor and all five binding attributes · array add /
remove / reorder · image replace committed through `/api/upload` · plain-text
paste, crash buffer, and the unsaved-edit guard · git-commit save with
Google-or-token auth, conflict merge, and History with restore-as-a-new-commit ·
the page-meta editor · the first-visit setup checklist · `platercms dev` local
leg and `platercms serve` self-host leg · click-to-note capture, relay, notes
tray, and agent host (PR-by-default) · design-alternatives mode · versions,
`?draft=` flipping, autosave, and promote · review state with content hashing ·
feeds, sitemap, redirects, editable 404, manifest, llms.txt · per-page content
files via `?file=` · static publishing · optional email-capture worker.

**Known gaps and next steps:**

- **npm publish is pending the first release tag.** The packages are named,
  versioned, and wired to publish from a `v*` tag with provenance
  (`.github/workflows/release.yml`), but nothing is on the registry yet — so
  `npm create platercms@latest` and `npx platercms` don't resolve until that tag
  ships. Today you consume Plater from a checkout (`platercms init` / `platercms
  sync`).
- **The one-click `platercms-starter` repo doesn't exist yet.** Deploy-to-Vercel
  today means `platercms init` (which writes `vercel.json`), push, import, set
  the environment variables. The zero-terminal button is a post-publish task.
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
- **The documented rewrites are Vercel's.** The handlers are plain `(req, res)`
  functions, and `platercms serve` runs them — with those rewrites reimplemented —
  on a bare `node:http` server, which is the answer for self-hosting. Cloudflare
  Pages and Netlify equivalents still aren't written down.
- **Tests cover the server seams**, not the browser. There's no headless test of
  the editor overlay in this repo; the editor is verified by driving a real
  browser with Playwright from outside it.

Deprecations: `zms-core.js` / `zms-capture.js` vendored paths, `.zms-sync.json`,
`initZMS()`, `ZMS_WEB_ROOT`, and `ZMS_AGENT_*` are still accepted — a site
vendored before the rename keeps working untouched. New installs use
`plater-core.js` / `plater-capture.js`, `.plater-sync.json`, `initPlater()`,
`PLATER_WEB_ROOT`, and `PLATER_AGENT_*`. The `zms` **command** is gone; the CLI
is `platercms`.

## Contributing

Issues and PRs welcome. The bar is the same as the codebase: no runtime
dependencies, no build step, no framework. `npm test` and `npm run lint` must
pass — CI runs both on Node 20 and 22.

## License

MIT — see [LICENSE](LICENSE).
