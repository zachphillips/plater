#!/bin/bash
# Start (or self-heal) the Plater agent host in a tmux session on Trapjaw.
# Sources host.env INSIDE the tmux command so it works even when a pre-existing
# tmux server holds a stale environment (the gotcha: `tmux new-session` inherits
# the running server's env, not the caller's). Wired to cron (@reboot + */5).
cd "$HOME/zms-agent" || exit 1
curl -sf localhost:8787/health >/dev/null 2>&1 && exit 0
tmux kill-session -t zmshost 2>/dev/null
tmux new-session -d -s zmshost "cd $HOME/zms-agent && set -a && . ./host.env && set +a && exec /usr/bin/node host/server.mjs > host.log 2>&1"
