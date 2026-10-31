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

- `engine`: `claude` (default; structural/design), `codex`, `local` (Ollama via codex; draft quality only).
- `output`: `pr` (default — opens a PR) or `push` (commits to main; auto-deploys if git-connected).
- Chosen per-note in the UI (the chooser), falling back to the site's defaults in `sites.json`.

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
