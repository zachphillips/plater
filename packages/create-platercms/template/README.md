# Your Plater site

A one-page site you own outright: hand-written HTML, one CSS file, and all the
copy in [`content/site.json`](content/site.json). [Plater](https://github.com/zachphillips/plater)
renders that JSON into the page through `data-bind` attributes, lets you edit
the page in the browser, and commits every save to git. No database, no build
step, no framework.

The HTML is the fallback: with JavaScript off, or with a key missing from
`site.json`, the page still renders the copy that is written in the markup.

## Run it

```bash
npx platercms dev .          # http://127.0.0.1:4188
open 'http://127.0.0.1:4188/?edit'
```

In dev there is no auth and no GitHub — clicking Save writes straight to
`content/site.json` on disk. Commit when you like what you see.

```bash
npx platercms doctor .       # what's wired, what's missing, and the env checklist
```

## Edit it

- **Copy:** click into it under `?edit` (or press Cmd/Ctrl+E), type, Save.
- **Structure:** `index.html`. `data-bind` is text, `data-bind-attr="path:attr"`
  is an attribute, `data-list` is an array of strings, `data-cards` clones the
  `<template>` once per array item, `data-links` is an array of `{label, href}`.
  Add a binding, add the matching key to `site.json`, done.
- **Design:** `styles.css` — the custom properties at the top are the fast path.

## Deploy it

Push to GitHub and import the repo on Vercel. `vercel.json` already wires
`/feed.xml`, `/feed.json`, `/sitemap.xml`, `/llms.txt`, and the editable 404 to
the `api/` handlers, so the only remaining step is environment variables: copy
the keys from [`.env.example`](.env.example) into your project settings. Set
`CMS_ADMIN_EMAIL` (Google) or `CMS_EDIT_TOKEN` (phone and iPad), plus
`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `CMS_SITE_URL`. Until you do, the site
is live and read-only — editing fails closed by design.

Renaming a URL means adding a redirect to `site.json`'s `redirects` in the same
change, so old links keep working.
