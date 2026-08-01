# Plater — agent briefing

You are working in **Plater**: a dependency-free, framework-free CMS for static
and Node sites. Read `README.md` first; this file is only the operating rules.

## What it is, in one paragraph

HTML pages carry `data-bind` attributes; the values live in
`content/site.json`. `@platercms/core` renders them, makes them `contenteditable`
under `?edit`, and POSTs changes to `/api/save`, which commits the JSON to
GitHub via the Contents API. `@platercms/capture` lets an editor click an element,
leave a note, and route it — through `/api/agent-note` and the agent host — to a
coding agent that opens a PR. Everything else in the repo is plumbing around
those two loops.

## Commands

```bash
npm test        # node --test — the only test runner; no dev dependencies
npm run lint    # node --check on every .js/.mjs — the only linter
npm run demo    # serve examples/static-site at http://127.0.0.1:4188
npm run dev     # plater dev on the current directory
node cli/plater.js doctor <siteDir>   # report a site's wiring + env checklist
```

CI (`.github/workflows/ci.yml`) runs `lint` then `test` on Node 20 and 22. Both
must pass. There is nothing to install — `npm ci` is not part of CI because the
repo has zero dependencies, and that is a feature, not an oversight.

## Hard constraints

1. **No runtime dependencies. No dev dependencies. No build step. No framework.**
   If a change needs a package, the change is wrong. Node's standard library and
   browser platform APIs only. (Playwright in the agent host is the single
   exception, dynamically imported and optional.)
2. **Every handler must work unchanged in all three legs** — `plater dev` (disk),
   preview branch, production. Handlers read env at import time; `cli/dev.mjs`
   sets env *before* importing them. Don't break that ordering.
3. **Auth fails closed.** With no `CMS_ADMIN_EMAIL` configured, `verifyGoogle`
   must reject. Never compare a token email against an empty allowlist. Token
   comparisons use `crypto.timingSafeEqual`, never `===`.
4. **The browser never sees a secret.** `GITHUB_TOKEN` and `PLATER_AGENT_TOKEN` are
   server-side only. `/api/agent-note` forces `site` to `CMS_SITE_NAME`.
5. **Authored HTML is the fallback.** A page must render correctly with
   JavaScript disabled and with `site.json` missing keys.
6. **PR by default.** Agent-routed changes produce a pull request unless a site
   is explicitly configured `output: "push"`.
7. **No taxonomy features.** No tags, categories, channels, or collections. The
   feed is a hand-curated array. This is a product decision, not a gap.
8. **Renaming a URL means adding a redirect in the same change** (`site.json`
   `redirects`). Permalinks don't break.
9. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with".

## Layout

```
cli/            plater CLI: doctor, init, sync, publish, dev, deploy-amber
packages/core         the browser editor (src/editor.js)
packages/capture      the click-to-note overlay (src/capture.js)
packages/server-node  12 serverless handlers, one file each
packages/agent-host   the long-running agent runner (server.mjs + deploy/)
packages/list-worker  optional Cloudflare Worker email capture
examples/static-site  a complete working site — the demo target
docs/                 the GitHub Pages marketing site
test/                 node:test suites (the only test dir)
```

## Conventions

- ES modules everywhere, `.js` in packages, `.mjs` for standalone scripts.
- Handlers export `default async function handler(req, res)` (Vercel shape).
- Long explanatory comments at the top of each file are intentional — they are
  the design docs. Update them when behavior changes; don't strip them.
- `zms`-prefixed names (`ZMS_AGENT_*`, `ZMS_WEB_ROOT`, `zms-core.js`, `initZMS`)
  are the deprecated-but-supported aliases. Don't add new ones; don't delete old
  ones before 1.0. Every one of them must have a `PLATER_`/`plater` name to
  migrate TO — an env var read only under its `ZMS_` spelling is a bug, not an
  alias.
- Deprecations stay dual-accepted until a major version.
