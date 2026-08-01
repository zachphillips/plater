#!/bin/bash
# Stand up the Cloudflare Tunnel for the Plater agent host.
# PREREQUISITE: run `~/bin/cloudflared tunnel login` first and authorize YOUR
# zone (creates ~/.cloudflared/cert.pem). This script is safe to re-run.
#
#   PLATER_AGENT_HOSTNAME=agent.example.com ./setup-tunnel.sh
set -e
CF="$HOME/bin/cloudflared"
HOSTNAME="${PLATER_AGENT_HOSTNAME:-${ZMS_AGENT_HOSTNAME:?set PLATER_AGENT_HOSTNAME, e.g. agent.example.com}}"
PORT="${PLATER_AGENT_PORT:-${ZMS_AGENT_PORT:-8787}}"
NAME="zms-agent"

if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "ERROR: no cert.pem. Run '$CF tunnel login' and authorize your zone first." >&2
  exit 1
fi

# create the tunnel if it doesn't exist
if ! $CF tunnel list 2>/dev/null | grep -q "$NAME"; then
  $CF tunnel create "$NAME"
fi
TID=$($CF tunnel list | awk -v n="$NAME" '$0 ~ n {print $1; exit}')
echo "tunnel id: $TID"

# ingress config: only $HOSTNAME -> the local host; everything else 404
cat > "$HOME/.cloudflared/config.yml" <<CFG
tunnel: $TID
credentials-file: $HOME/.cloudflared/$TID.json
ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$PORT
  - service: http_status:404
CFG

# point the DNS record at the tunnel (in your Cloudflare-managed zone)
$CF tunnel route dns "$NAME" "$HOSTNAME" || true

# persist: start script + cron (no sudo), mirroring the host's approach
cat > "$HOME/zms-agent/start-tunnel.sh" <<SH
#!/bin/bash
pgrep -f "cloudflared tunnel run $NAME" >/dev/null && exit 0
tmux kill-session -t zmstunnel 2>/dev/null
tmux new-session -d -s zmstunnel "$CF tunnel run $NAME > \$HOME/zms-agent/tunnel.log 2>&1"
SH
chmod +x "$HOME/zms-agent/start-tunnel.sh"
( crontab -l 2>/dev/null | grep -v "start-tunnel.sh"; echo "@reboot $HOME/zms-agent/start-tunnel.sh"; echo "*/5 * * * * $HOME/zms-agent/start-tunnel.sh" ) | crontab -
"$HOME/zms-agent/start-tunnel.sh"
sleep 3
echo "tunnel up. Test: curl -sS https://$HOSTNAME/health"
