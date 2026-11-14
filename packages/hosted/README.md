# Hosted Plater

One Cloudflare Worker that gives every draft shared for review a permanent
address. Every version is kept, and so is the record of what was reviewed.

```
https://<host>/                      every project
https://<host>/<project>/            the latest version, editable in place
https://<host>/<project>/v<n>/       version n exactly as it was, read-only
https://<host>/<project>/review      every version, how it was made, its notes,
                                     and who marked what reviewed, and when
```

## Sharing a draft

```bash
source ~/.agents/secrets/plater.env      # PLATER_PUBLISH_TOKEN (+ PLATER_HOSTED_URL)
platercms share <dir> --project <slug> [--title "…"] [--message "what changed"]
```

The web root is found the way `plater dev` finds it. Only files not already
stored are uploaded. Sharing again makes the next version and never replaces
one.

## On the page

Pages are ordinary Plater pages. The Worker answers the editor's `/api/*` calls
(config, content, save with conflict detection, history and restore, review
marks, image upload, live updates), so `@platercms/core` runs unchanged. A page
that doesn't load the editor gets it injected, along with the ✎ Note overlay and
a version pill that links to the history.

- **Typing on the page** saves the next version. A run of edits by the same
  person within 15 minutes, on a version nobody has marked reviewed, stays one
  version.
- **✎ Note** queues the note. The runner (below) applies it on the owner's
  ChatGPT plan, the result becomes the next version, and the open tab reloads.
  The note runs against the version it was left on. If someone edited the same
  file on the page in the meantime, the note fails rather than overwriting
  that edit.
- **Older versions** are read-only. Restoring an older version's copy from
  History makes a new version.

## The note runner

`runner.mjs` runs on the owner's always-on machine, next to their ChatGPT plan
sign-in (`packages/agent-host/chatgpt.mjs`; `move-to <host>` moves a sign-in
there). It claims one note at a time, rebuilds that version's files in a
scratch folder, runs one Codex turn there through the plan engine (same speed
settings, isolated `CODEX_HOME`), and posts the changed files back. It runs only
the owner's notes. A note from anyone else is refused before it reaches the
plan. The Worker never holds or uses the plan's credentials.

Env (or `~/.config/plater/hosted.env`): `PLATER_HOSTED_URL`,
`PLATER_RUNNER_TOKEN`, `PLATER_OWNER_EMAIL`, `PLATER_CHATGPT_PLAN=1`.

## Deploying

1. Create a D1 database and an R2 bucket, and run `schema.sql` on the database.
2. Create a Cloudflare Access application for the hostname with an allow policy
   for your email, plus **bypass** applications for `<host>/_hosted` (the
   machine API, which checks its own bearer tokens) and `<host>/robots.txt`.
3. Write a local config (see the header of `deploy.mjs`) and run
   `PUBLISH_TOKEN=… RUNNER_TOKEN=… node packages/hosted/deploy.mjs <config.json> --secrets`
   with `CLOUDFLARE_API_TOKEN` set.

The Worker also checks the Access assertion itself (signature, audience,
issuer, expiry, email allowlist) and refuses everything without one. Pages and
responses are marked `noindex`, and `robots.txt` disallows everything.

## Proof

`npm run verify:hosted` runs the real `worker.js` under local stand-ins
(`local.mjs`: D1 on `node:sqlite` with this schema, R2 in memory, Access as a
local signing key). Headless Chromium then shares, edits, sends a ✎ Note through
the real runner, checks that the old version is unchanged, and marks a version
reviewed. `test/hosted.test.js` guards the gate. Both need Node 22 or later.
