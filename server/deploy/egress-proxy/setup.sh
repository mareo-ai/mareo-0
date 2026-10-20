#!/usr/bin/env bash
#
# Egress proxy for the Mareo gateway.
#
# Run this on a fresh host outside the network that blocks the model vendor
# (the Hangzhou gateway cannot reach api.openai.com; see docs/operations.md).
# It installs Squid, allows exactly one source address with a password, and
# prints the OPENAI_PROXY_URL line to paste into the gateway's .env.
#
#   sudo ALLOW_FROM=114.55.15.112 ./setup.sh
#
# Nothing here is vendor-specific: it is a plain HTTP CONNECT proxy.
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
apt-get install -y -qq squid apache2-utils curl >/dev/null

# One credential, hashed; the file is readable by Squid only.
htpasswd -bc /etc/squid/passwd "$PROXY_USER" "$PROXY_PASS" >/dev/null
chown root:proxy /etc/squid/passwd 2>/dev/null || chown root:root /etc/squid/passwd
chmod 640 /etc/squid/passwd

# A minimal config replaces the shipped one: the default already ends with
# `http_access deny all`, so an appended include would never be reached.
if [ -f /etc/squid/squid.conf ] && [ ! -f /etc/squid/squid.conf.mareo-original ]; then
  cp /etc/squid/squid.conf /etc/squid/squid.conf.mareo-original
fi
cat > /etc/squid/squid.conf <<EOF
# Mareo egress proxy. Managed by server/deploy/egress-proxy/setup.sh.
http_port ${PROXY_PORT}

auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm mareo-egress
auth_param basic credentialsttl 12 hours

acl mareo_auth proxy_auth REQUIRED
acl mareo_src src ${ALLOW_FROM}
http_access allow mareo_src mareo_auth
http_access deny all

# This proxy forwards model calls; nothing about them is cached or announced.
cache deny all
via off
forwarded_for delete
access_log /var/log/squid/access.log

# Name resolution happens here, outside the network that blocks the vendor.
dns_nameservers 1.1.1.1 8.8.8.8
EOF

squid -k parse >/dev/null 2>&1 || { echo "Squid 配置校验失败，见 /var/log/squid/cache.log" >&2; exit 1; }
systemctl enable --now squid >/dev/null 2>&1
systemctl restart squid

echo
echo "=== 自检：经本机代理访问 vendor ==="
# 401 means "reached the vendor, no key" — that is the healthy answer.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -x "http://127.0.0.1:${PROXY_PORT}" \
  -U "${PROXY_USER}:${PROXY_PASS}" https://api.openai.com/v1/models || true)
echo "  经代理访问 api.openai.com → HTTP ${code}（401 = 通了；403 = 该地区被拒；000 = 本机也不通）"
echo
echo "=== 把下面这行写进生产服务器的 /srv/mareo/server/deploy/.env ==="
echo "OPENAI_PROXY_URL=http://${PROXY_USER}:${PROXY_PASS}@<这台机器的公网IP>:${PROXY_PORT}"
echo
echo "然后把公网 IP 告诉我，我从生产机验证一次（我不会看到密码之外的东西）。"
