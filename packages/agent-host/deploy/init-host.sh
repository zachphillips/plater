#!/bin/bash
# plater host init — stand up an ISOLATED Plater agent-host for one owner
# (you, or a client). One instance per owner, on the owner's box, with the
# owner's own LLM keys: a client's notes must NEVER run agents on your
# hardware, and their token spend must be their own.
#
#   ./init-host.sh <owner-slug> [--port 8788] [--workdir ~/plater-host-<owner>]
#
# What it does (idempotent):
#   1. Creates the workdir: host/server.mjs (copied from this package),
#      sites.json (EMPTY allowlist — add the owner's repos, nobody else's),
#      host.env (fresh PLATER_AGENT_TOKEN; slots for the owner's engine auth),
#      start.sh + a */5 cron self-heal, jobs.jsonl journal.
#   2. Prints the exact next steps: engine login (claude/codex as the OWNER's
#      account), repo checkouts, tunnel (setup-tunnel.sh with the owner's
#      hostname), and the two env vars to set on the owner's sites.
#
# The design invariant: the site→repo mapping lives in the owner's sites.json
# on the owner's box, and the bearer only unlocks that box. Two owners can
# never touch each other's repos because nothing they hold names them.
set -euo pipefail

OWNER="${1:?usage: init-host.sh <owner-slug> [--port N] [--workdir DIR]}"; shift || true
PORT=8788; WORKDIR="$HOME/plater-host-$OWNER"
while [ $# -gt 0 ]; do case "$1" in
  --port) PORT="$2"; shift 2;;
  --workdir) WORKDIR="$2"; shift 2;;
  *) echo "unknown flag $1" >&2; exit 1;;
esac; done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$WORKDIR/host" "$WORKDIR/repos"
cp "$HERE/server.mjs" "$WORKDIR/host/server.mjs"

if [ ! -f "$WORKDIR/sites.json" ]; then
  cat > "$WORKDIR/sites.json" <<JSON
{
  "_comment": "Allowlist for owner '$OWNER' ONLY. Each entry: repo (org/name), path (checkout under $WORKDIR/repos), defaultEngine, defaultOutput. A caller can only name a site listed here — never an arbitrary repo."
}
JSON
fi

if [ ! -f "$WORKDIR/host.env" ]; then
  TOKEN=$(openssl rand -hex 32)
  cat > "$WORKDIR/host.env" <<ENV
# plater agent-host · owner: $OWNER · created $(date -u +%Y-%m-%dT%H:%M:%SZ)
# THE OWNER'S OWN CREDENTIALS GO HERE — never your keys on a client host.
PLATER_AGENT_TOKEN=$TOKEN
PLATER_AGENT_PORT=$PORT
PLATER_AGENT_WORKDIR=$WORKDIR
PLATER_AGENT_SITES=$WORKDIR/sites.json
# Engine auth (pick what the owner has):
#   claude:  run 'claude login' as this user, or set ANTHROPIC_API_KEY=
#   codex:   run 'codex login' as this user, or set OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
ENV
  chmod 600 "$WORKDIR/host.env"
fi

cat > "$WORKDIR/start.sh" <<SH
#!/bin/bash
# Start (or self-heal) the '$OWNER' plater agent host. Wire to cron:
#   @reboot $WORKDIR/start.sh
#   */5 * * * * $WORKDIR/start.sh
cd "$WORKDIR" || exit 1
curl -sf localhost:$PORT/health >/dev/null 2>&1 && exit 0
tmux kill-session -t "plater-$OWNER" 2>/dev/null
tmux new-session -d -s "plater-$OWNER" "cd $WORKDIR && set -a && . ./host.env && set +a && exec node host/server.mjs > host.log 2>&1"
SH
chmod +x "$WORKDIR/start.sh"

echo "✓ isolated host for '$OWNER' at $WORKDIR (port $PORT)"
echo
echo "Next steps (as the OWNER):"
echo "  1. Engine auth:   claude login   (or codex login, or put an API key in host.env)"
echo "  2. Repos:         git clone the owner's site repos into $WORKDIR/repos/"
echo "                    and list them in $WORKDIR/sites.json"
echo "  3. Start:         $WORKDIR/start.sh   (+ add the cron lines from start.sh header)"
echo "  4. Tunnel:        PLATER_AGENT_HOSTNAME=agent.<ownerdomain> PLATER_AGENT_PORT=$PORT \\"
echo "                      $HERE/deploy/setup-tunnel.sh   (needs the owner's CF zone login)"
echo "  5. On each site (Vercel env):"
echo "       PLATER_AGENT_ENDPOINT=https://agent.<ownerdomain>"
echo "       PLATER_AGENT_TOKEN=<the token in $WORKDIR/host.env>"
echo
echo "For design mode (image alternatives): npm i playwright && npx playwright install chromium"
echo "in $WORKDIR, and make sure the codex CLI can generate images under the owner's plan."
