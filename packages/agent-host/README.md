# @zms/agent-host

The persistent service that turns a captured note into an agent turn. Runs on
**Trapjaw** (always-on, RTX 3080, `claude` + `codex` + `ollama` already
authenticated). Sits behind a **Cloudflare Tunnel** (`agent.thekitchen.co`).

## Flow

```
iPad (authed CMS admin)
  → site's own /api/agent-note   (same-origin; verifies edit-token/Google)
      → agent.thekitchen.co/note (Cloudflare Tunnel → Trapjaw; server-side bearer)
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

- `engine`: `claude` (default; structural/design), `codex`, `local` (Ollama qwen-coder on the 3080; draft quality).
- `output`: `pr` (default — opens a PR) or `push` (commits to main; auto-deploys if git-connected).
- Chosen per-note in the UI (the chooser), falling back to the site's defaults in `sites.json`.

## Run on Trapjaw

```bash
export ZMS_AGENT_TOKEN=$(openssl rand -hex 32)   # the shared secret (also set on the sites)
export ZMS_AGENT_WORKDIR=$HOME/zms-agent
# clone the fleet repos into $ZMS_AGENT_WORKDIR/repos/<name> and write sites.json
node server.mjs        # or via the systemd unit + `cloudflared` tunnel
```

Env: `ZMS_AGENT_PORT` (8787), `ZMS_AGENT_TOKEN` (required), `ZMS_AGENT_WORKDIR`,
`ZMS_AGENT_SITES`, `ZMS_AGENT_CONCURRENCY` (2), `ZMS_AGENT_TIMEOUT_MS`,
`ZMS_AGENT_RATE` (20/min), `ZMS_LOCAL_MODEL` (qwen2.5-coder:7b).

## Security checklist

- [x] Constant-time bearer compare on every mutating request
- [x] Server-side site→repo allowlist (no client-chosen repos)
- [x] PR-by-default (human-in-the-loop)
- [x] Rate limit + concurrency cap + per-job timeout
- [x] Append-only audit journal (`jobs.jsonl`)
- [ ] Cloudflare Tunnel + (optional) Cloudflare Access in front — set up at deploy
- [ ] Fine-grained GitHub token scoped to the fleet repos only
