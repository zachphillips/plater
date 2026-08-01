# Wire Plater onto your existing site in 5 minutes

You have a site: HTML files, served statically, deployed from a GitHub repo. This
adds in-browser editing that saves as a git commit, plus click-to-note agent
routing. Node 20+. Nothing to install — Plater has zero dependencies and no build
step.

Starting from nothing instead? `npm create platercms@latest my-site` gives you a
running site with all of this already wired.

---

## 0. Scaffold — 30 seconds

```bash
cd your-site
npx platercms init .
```

`init` finds your web root (`web/`, `public/`, else the project root), vendors
`plater-core.js` and `plater-capture.js` next to your HTML, and scaffolds thirteen
`api/` handlers — `config`, `content`, `save`, `history`, `upload`, `agent-note`,
`review`, `versions`, `feed`, `sitemap`, `route`, `manifest`, `propose-post`. It
fills in the pieces you don't have yet (`app.js`, `content/site.json`,
`vercel.json`, `.env.example`) and leaves the rest alone.

**It never overwrites a file you already have.** Your `index.html`, your
`content/`, your `app.js` are kept as they are, and every skip is printed. Then:

```bash
npx platercms doctor .      # what's wired, what's missing, the env checklist
```

## 1. Three bindings on a page you already have

Content lives in `content/site.json`. The markup you already wrote stays exactly
where it is and becomes the fallback: with a key missing, or JavaScript off, the
page still renders what's in the HTML.

**Text — `data-bind`:**

```html
<h1 data-bind="hero.title">Buildings that age well.</h1>
```

**An attribute — `data-bind-attr="contentPath:attribute"`** (works in `<head>`
too, so `<title>`, canonical, and OG tags stay editable):

```html
<a class="button" href="mailto:hello@example.com"
   data-bind="hero.cta.label" data-bind-attr="hero.cta.url:href">Start a conversation</a>
```

**A repeating list — `data-cards` + a `<template>`:**

```html
<div class="cards" data-cards="work.projects">
  <template>
    <article class="card">
      <h3 data-field="title"></h3>
      <p data-field="summary"></p>
      <a class="card-link" data-field-link="url" hidden>View project →</a>
    </article>
  </template>

  <!-- your existing cards stay put: they are the no-JS fallback -->
  <article class="card"><h3>Alder Shed</h3><p>Timber, 2025.</p></article>
</div>
```

`content/site.json` for exactly those three:

```json
{
  "hero": {
    "title": "Buildings that age well.",
    "cta": { "label": "Start a conversation", "url": "mailto:hello@example.com" }
  },
  "work": {
    "projects": [
      { "title": "Alder Shed", "summary": "Timber, 2025.", "url": "/work/alder/" }
    ]
  }
}
```

Two more when you want them: `data-list="studio.services" data-list-tag="li"` for
an array of strings, `data-links="footer.links"` for an array of
`{ label, href }`. In edit mode every array gets per-item ×/↑/↓ and a **+ Add**.

## 2. The CMS bar

Paste this as the first thing inside `<body>`. It ships hidden; the editor
un-hides it on `?edit`, on Cmd/Ctrl+E, or when someone clicks **Edit Live**.
**Keep the ids** — the editor wires them by id. Style it however your site
looks; nothing here is prescribed but the ids.

```html
<div id="cms-bar" hidden>
  <span class="cms-brand">Your Site</span>
  <button id="cms-impeccable" type="button">✦ Edit Live</button>
  <span id="cms-signin"></span>
  <button id="cms-edit" type="button" hidden>Edit page</button>
  <button id="cms-save" type="button" hidden>Save &amp; commit</button>
  <button id="cms-cancel" type="button" hidden>Cancel</button>
  <span id="cms-status">read-only</span>
</div>
```

The History button adds itself to this bar in edit mode, and on a multi-page site
a sitemap rail with a reviewed checkbox per page appears alongside it.

## 3. `initPlater`

`app.js`, next to the vendored `plater-core.js`:

```js
import { initPlater } from './plater-core.js';

// Held in a binding: @platercms/capture authenticates with the same credential.
const plater = initPlater({ brand: 'Your Site' });
```

and in the page, at the end of `<body>`:

```html
<script type="module" src="./app.js"></script>
```

Nothing here blocks the render. The page is complete HTML before the module
loads; the module only rehydrates it from `content/site.json`.

Never hand-edit `plater-core.js` or `plater-capture.js` — they are vendored
copies. Update them with `npx platercms sync .`.

## 4. One save

```bash
npx platercms dev .
open 'http://127.0.0.1:4188/?edit'
```

Click into a bound element, type over it, hit **Save & commit**. Locally there is
no auth and the save is a plain file write to `content/site.json`; the GitHub
token is force-unset in dev, so dev can never commit. You commit when you like
what you see.

Deployed, the identical handler fetches the current JSON from the GitHub Contents
API, deep-merges only the keys you changed, and PUTs it back as a commit — which
triggers the deploy you already had. If someone else committed while you were
editing, the save answers 409 and the editor replays your fields on top of theirs
and hands the page back, still in edit mode, for a look before the second save.

Set on your host (never in the repo):

```
CMS_ADMIN_EMAIL=you@example.com     # the one Google account allowed to save
CMS_EDIT_TOKEN=                     # shared token, phone/iPad path — openssl rand -hex 32
GITHUB_TOKEN=                       # fine-grained PAT, contents:write on this repo only
GITHUB_REPOSITORY=you/your-site
GITHUB_BRANCH=main
GITHUB_EDIT_PATH=content/site.json  # default is web/content/site.json — match where init put it
CMS_SITE_URL=https://example.com    # feeds and sitemap need an absolute origin
```

Set at least one of `CMS_ADMIN_EMAIL` / `CMS_EDIT_TOKEN`. With neither, every
write **fails closed** and the site serves read-only — that is the intended state
until you say who may edit.

Not on Vercel? `npx platercms serve .` runs the same handlers on a bare Node
host, auth on, reading `KEY=VALUE` lines from `.env` for anything the host
doesn't set.

## 5. One agent note

Copy edits are half of it. "Make these three cards a single column on phones" is
markup and CSS, not content. Route it instead — in `app.js`:

```js
import { initCapture } from './plater-capture.js';
initCapture({ apiBase: '/api', getToken: plater.getToken, brand: 'Your Site' });
```

`getToken` is why `initPlater`'s return value is held: capture authenticates with
the same credential the editor holds.

Then, in edit mode: **✎ Note** → click the element → one sentence → **Send**. The
browser posts to your own origin at `/api/agent-note`, which re-checks your
credential, overwrites the site field with its own configured name, and forwards
the note with a server-side bearer the browser never sees. The default output is
a pull request. The **Notes** tray lists everything you have sent, with live
status and a link to the PR.

Needs two more variables on the host, plus a machine you own running the agent
host (`packages/agent-host/`):

```
PLATER_AGENT_ENDPOINT=https://agent.example.ts.net
PLATER_AGENT_TOKEN=
```

Without them `/api/agent-note` answers 501 and the overlay says so plainly. In
`platercms dev` notes are echoed, never fired — a local session cannot start a
real agent job by accident.

---

## Next

- `templates/starter/` — all of the above already wired: `index.html`, `app.js`,
  `content/site.json`, `styles.css`, `vercel.json`, `.env.example`.
- `examples/static-site/` — three pages, every binding attribute in use.
  `npm run demo` serves it.
- `npx platercms doctor .` — run it after every step above.
- [README](../README.md) — named drafts and `?draft=`, review state, feeds,
  sitemap, redirects, the editable 404, `llms.txt`, static publishing, and how to
  stand up the agent host.
