#!/usr/bin/env bash
#
# Egress relay for the Mareo gateway — run this ON the relay host, once.
#
# The Hangzhou gateway cannot reach api.openai.com. A plain HTTP proxy is not
# enough either: the connection is reset before the proxy answers, because the
# target hostname is visible in a plaintext CONNECT and in the TLS SNI. The
# traffic has to arrive through an encrypted tunnel, which is what
# tunnel-setup.sh builds; this script only makes the local relay end of it.
#
#   sudo ALLOW_FROM=114.55.15.112 ./relay-setup.sh
#
# Verified on Ubuntu 24.04 with tinyproxy 1.11 (~6 MB resident, which matters on
# a small shared box).
set -euo pipefail

ALLOW_FROM="${ALLOW_FROM:-114.55.15.112}"
PROXY_PORT="${PROXY_PORT:-3128}"
PROXY_USER="${PROXY_USER:-mareo}"
PROXY_PASS="${PROXY_PASS:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行（sudo）" >&2
  exit 1
fi

apt-get update -qq
apt-get install -y -qq tinyproxy curl >/dev/null

# This host resolves dual-stack names to IPv6 first but has no IPv6 route, so a
# proxy that honours getaddrinfo order connects to a dead address and the client
# sees a reset. Prefer IPv4.
if ! grep -qE '^precedence ::ffff:0:0/96' /etc/gai.conf 2>/dev/null; then
  printf '\n# Prefer IPv4: this host has no global IPv6.\nprecedence ::ffff:0:0/96  100\n' >> /etc/gai.conf
fi

# Loopback is allowed because the gateway's traffic arrives through the SSH
# tunnel, not from its public address.
cat > /etc/tinyproxy/mareo.conf <<EOF
# Mareo egress relay. Managed by server/deploy/egress-proxy/relay-setup.sh.
Port ${PROXY_PORT}
Listen 0.0.0.0
Timeout 600
Allow ${ALLOW_FROM}
Allow 127.0.0.1
BasicAuth ${PROXY_USER} ${PROXY_PASS}
ConnectPort 443
ConnectPort 80
DisableViaHeader Yes
LogLevel Info
LogFile "/var/log/tinyproxy/mareo.log"
PidFile "/run/tinyproxy/mareo.pid"
EOF
chmod 600 /etc/tinyproxy/mareo.conf

# A drop-in points the packaged unit at this config; the shipped one is untouched.
mkdir -p /etc/systemd/system/tinyproxy.service.d
cat > /etc/systemd/system/tinyproxy.service.d/mareo.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/tinyproxy -d -c /etc/tinyproxy/mareo.conf
EOF
systemctl daemon-reload
systemctl enable --now tinyproxy >/dev/null 2>&1
systemctl restart tinyproxy

echo "  本机自检：经代理访问 api.openai.com"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -x "http://127.0.0.1:${PROXY_PORT}" \
  -U "${PROXY_USER}:${PROXY_PASS}" https://api.openai.com/v1/models || true)
echo "    → HTTP ${code}（401 = 通；403 = 该地区被 OpenAI 拒；000 = 本机也不通）"
echo
echo "  代理地址（写入网关 .env 时用这个，主机部分由隧道决定）："
echo "    http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${PROXY_PORT}"
