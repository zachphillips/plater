# @platercms/agent-host

The persistent service that runs a coding agent on notes captured from your sites. Runs on
any always-on box you control, with `claude` / `codex` / `ollama` already
authenticated as **you**. Sits behind a **Cloudflare Tunnel** (`agent.<your-domain>`).

## Flow

```
iPad (authed CMS admin)
  → site's own /api/agent-note   (same-origin; verifies edit-token/Google)
      → agent.<your-domain>/note (Cloudflare Tunnel → your box; server-side bearer)
          → runner: fresh branch → run engine in repo checkout → commit → PR
```

The browser never holds the agent-host secret. The site→repo mapping is
server-side (`sites.json`), so a caller can only name an allowlisted site, never
an arbitrary repo. **PR by default** — a note becomes a reviewable pull request,
not a live deploy.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness + queue depth |
| POST | `/note` | Bearer | enqueue `{ site, note, capture, route:{engine,output} }` |
| GET | `/jobs/:id` | Bearer | job status + PR url |
| POST | `/reload` | Bearer | re-read `sites.json` |

## Engines / output

- `engine`: `claude` (default; structural/design), `codex`, `local` (Ollama via codex; draft quality only), `chatgpt` (owner's ChatGPT plan; off by default, see below).
- `output`: `pr` (default — opens a PR) or `push` (commits to main; auto-deploys if git-connected).
- Chosen per-note in the UI (the chooser), falling back to the site's defaults in `sites.json`.

## ChatGPT plan engine (`chatgpt`, off by default)

An optional engine that runs a note on **the host owner's own ChatGPT plan**,
through OpenAI's open-source
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)
flow and Codex app-server. Plater never reads or reuses an existing Codex or
ChatGPT login. Codex runs with its own `CODEX_HOME` under the credentials
directory.

It runs only when all three of these hold. If any one is missing, the job ends
`plan-unavailable` with the reason. It never falls back to another engine.

1. `PLATER_CHATGPT_PLAN=1` on the agent host.
2. `"planUsage": true` on the site in `sites.json` (with `"defaultEngine": "chatgpt"`,
   or a note that routes to `engine: "chatgpt"`).
3. The owner has signed in on this machine and allowed plan usage:

   ```bash
   node packages/agent-host/chatgpt.mjs login    # prints a URL; open it here and approve
   node packages/agent-host/chatgpt.mjs status   # never prints tokens
   node packages/agent-host/chatgpt.mjs logout   # revokes with OpenAI, clears tokens
   ```

Credentials live in `PLATER_CHATGPT_DIR` (default `~/.config/plater/chatgpt`).
The directory is 0700 and the files are 0600. They have no export command and
are never shared. Optional settings: `PLATER_CHATGPT_MODEL` (a model from the
account's `/v1/models`) and `PLATER_CHATGPT_SANDBOX` (`workspace-write`).

**Who it is for.** OpenAI offers plan usage to open-source projects and
personal projects that run locally. Sign-in registers a client for that person
and that install (`dynamic_agent_client` → an issued `oaiapp_…` id). It is not a
shared team or Kitchen-wide credential. One person running their own agent host
on their own machine fits. A hosted, multi-user Plater, or teammates' notes
spending one person's plan, does not: paid or remotely hosted apps must
[request access](https://openai.com/form/sign-in-with-chatgpt-interest/) first,
and having the source open does not change that.

**Usage.** Requests count toward the user's ChatGPT and Codex usage limits, which
are shared with every other app. OpenAI says usage rates may differ between an
app and ChatGPT, and it publishes no multiplier. A `plan-limit` job status means
the limit was reached.

**Limits.** These are the preview limits: Responses API only, no hosted image
generation, file search, code interpreter or hosted MCP. Design jobs (image
generation) never use this engine.

`npm run verify:chatgpt` checks sign-in and a real `codex app-server` turn
against local fixtures. It does not sign in with OpenAI and uses no plan usage.

## Run it

```bash
export PLATER_AGENT_TOKEN=$(openssl rand -hex 32)   # the shared secret (also set on the sites)
export PLATER_AGENT_WORKDIR=$HOME/zms-agent
# clone each site's repo into $PLATER_AGENT_WORKDIR/repos/<name> and write sites.json
node server.mjs        # or via the systemd unit + `cloudflared` tunnel
```

Env: `PLATER_AGENT_PORT` (8787), `PLATER_AGENT_TOKEN` (required),
`PLATER_AGENT_WORKDIR` (default `~/zms-agent`), `PLATER_AGENT_SITES`,
`PLATER_AGENT_CONCURRENCY` (2), `PLATER_AGENT_TIMEOUT_MS`, `PLATER_AGENT_RATE`
(20/min), `PLATER_LOCAL_MODEL` (qwen2.5-coder:7b),
`PLATER_GIT_NAME` / `PLATER_GIT_EMAIL` (identity for agent-authored commits).
The `ZMS_AGENT_*` / `ZMS_LOCAL_MODEL` spellings are still accepted.

## Security checklist

- [x] Constant-time bearer compare on every mutating request
- [x] Server-side site→repo allowlist (no client-chosen repos)
- [x] PR-by-default (you review before anything merges)
- [x] Rate limit + concurrency cap + per-job timeout
- [x] Append-only audit journal (`jobs.jsonl`)
- [ ] Cloudflare Tunnel + (optional) Cloudflare Access in front — set up at deploy
- [ ] Fine-grained GitHub token scoped to your repos only
