#!/usr/bin/env bash
#
# Egress tunnel for the Mareo gateway — run this ON the gateway host (Hangzhou).
#
# It keeps an encrypted SSH tunnel to the relay, published on the Docker bridge
# address so the gateway container can reach it. Encryption is the point: the
# plaintext CONNECT and the TLS SNI are what get reset, so the proxy has to sit
# on the far side of a tunnel, not on the near side of one.
#
#   sudo RELAY_HOST=13.192.100.226 RELAY_USER=ubuntu ./tunnel-setup.sh
#
# Afterwards the gateway needs, in /srv/mareo/server/deploy/.env:
#   OPENAI_PROXY_URL=http://<user>:<pass>@<docker-bridge>:3129
set -euo pipefail

RELAY_HOST="${RELAY_HOST:?需要 RELAY_HOST（中继机 IP）}"
RELAY_USER="${RELAY_USER:-ubuntu}"
RELAY_PORT="${RELAY_PORT:-3128}"
LOCAL_PORT="${LOCAL_PORT:-3129}"
KEY="${KEY:-/root/.ssh/mareo-egress}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行（sudo）" >&2
  exit 1
fi

# The container reaches the host through the compose bridge; binding to the
# loopback address would only be reachable from the host itself.
BRIDGE_IP="$(docker network inspect mareo-gateway_default --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.18.0.1)"

if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  ssh-keygen -t ed25519 -N "" -f "$KEY" -q
  echo "  已生成隧道密钥：$KEY"
  echo "  把下面这行加到中继机的 ~/.ssh/authorized_keys，然后重新运行本脚本："
  cat "$KEY.pub"
  exit 2
fi

apt-get install -y -qq autossh >/dev/null 2>&1 || true

cat > /etc/systemd/system/mareo-egress-tunnel.service <<EOF
[Unit]
Description=Mareo egress tunnel to ${RELAY_HOST} (OpenAI upstream only)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/autossh -M 0 -N \\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \\
  -i ${KEY} \\
  -L ${BRIDGE_IP}:${LOCAL_PORT}:127.0.0.1:${RELAY_PORT} ${RELAY_USER}@${RELAY_HOST}
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mareo-egress-tunnel >/dev/null 2>&1
systemctl restart mareo-egress-tunnel
sleep 3
echo "  隧道状态: $(systemctl is-active mareo-egress-tunnel)"
ss -tlnp | grep ":${LOCAL_PORT} " | sed 's/^/  监听: /'
echo
echo "  容器的 OPENAI_PROXY_URL 应指向 http://<user>:<pass>@${BRIDGE_IP}:${LOCAL_PORT}"
