# @platercms/server-node

The server half of [Plater](https://github.com/zachphillips/plater): drop-in
`(req, res)` handlers for Vercel-style serverless functions or a bare
`node:http` server. Each file is standalone — no shared runtime, no imports
across handlers — so a site can vendor exactly the ones it uses.

Zero dependencies. No build step.

| Subpath | Route | What it does |
|---|---|---|
| `./config` | `/api/config` | what the browser is allowed to know: auth mode, feature flags |
| `./content` | `/api/content` | serves `site.json` (and alternates via `?file=`) |
| `./save` | `/api/save` | durable save — a real git commit, Google-or-token auth |
| `./history` | `/api/history` | recent commits for the edited file; one-click restore |
| `./upload` | `/api/upload` | drag-and-drop image upload, committed to the repo |
| `./agent-note` | `/api/agent-note` | relays a captured note to the agent host |
| `./review` | `/api/review` | per-page review state with content hashing |
| `./publish` | — | builds `content/pages` Markdown/HTML into static routes |
| `./propose-post` | `/api/propose-post` | proposed posts awaiting review |
| `./feed` | `/feed.xml`, `/feed.json` | feeds |
| `./sitemap` | `/sitemap.xml` | sitemap from the enumerated page walk |
| `./route` | catch-all | redirects and the editable 404 |
| `./manifest` | `/llms.txt` etc. | the agent-readable site manifest |
| `./versions` | `/api/versions` | named drafts: create, flip, promote |

```js
// api/save.js
export { default } from '@platercms/server-node/save';
```

Auth fails closed: with no `CMS_ADMIN_EMAIL` and no `CMS_EDIT_TOKEN`, nobody can
save. Secrets (`GITHUB_TOKEN`, `PLATER_AGENT_TOKEN`) are server-side only and
never reach the browser.

Most sites don't install it — `npm create platercms` and `platercms init` vendor
these files straight into `api/`, so the site runs with no `node_modules` at
all.

Full documentation, including the environment table:
<https://github.com/zachphillips/plater#readme>

MIT © Zach Phillips
