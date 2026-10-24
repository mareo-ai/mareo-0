#!/usr/bin/env bash
#
# Deploy the gateway without ever taking it down for a bug we could have caught.
#
# The rule this script exists to enforce: a build must prove it can migrate the
# real database *before* it is allowed to serve traffic. On 2026-10-24 a
# migration that added a column after creating its index restarted the gateway
# fifteen times; the only thing that could repair it was someone else's tooling,
# because the agent doing the deploy lost its own model access with it.
#
# Order:
#   1. back up database and source
#   2. build the image
#   3. rehearse the migration on a COPY of the database, in an isolated container
#   4. start the new container on port 3001, still not receiving traffic
#   5. point nginx at it, reload, verify from outside
#   6. stop the old container
#
# Any failure before step 5 leaves the running gateway untouched. Any failure at
# or after step 5 points nginx back and stops the new container.
#
# Only table/column additions may be deployed this way. A migration that drops or
# retypes anything must be done in a maintenance window with the gateway stopped.
set -euo pipefail

cd "$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
CURRENT_PORT=3000
NEXT_PORT=3001
REHEARSAL_PORT=3011
NGINX_CONF="/etc/nginx/conf.d/mareo-gateway.conf"
PUBLIC_URL="${PUBLIC_URL:-https://api.svc.mareo.cn}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

log() { echo "[deploy] $*"; }
fail() { echo "[deploy] ✗ $*" >&2; exit 1; }

# Waits until a container reports healthy, or gives up.
wait_healthy() {
  local name="$1" waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    local state
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$state" in
      healthy) return 0 ;;
      missing|exited|dead) return 1 ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# A container that is up is not the same as a container that works: ask it for a
# real row from the real schema.
probe() {
  local port="$1"
  curl -fsS -m 5 "http://127.0.0.1:${port}/health" >/dev/null || return 1
  docker compose exec -T gateway node -e "
    import('/app/dist/src/db.js').then(({ openDatabase }) => {
      const db = openDatabase(process.env.DB_PATH ?? 'data/mareo.db')
      const v = db.prepare('PRAGMA user_version').get().user_version
      const users = db.prepare('SELECT COUNT(*) n FROM users').get().n
      db.close()
      if (!Number.isInteger(v) || users < 1) process.exit(1)
      console.log('[deploy] schema v' + v + ', ' + users + ' accounts readable')
    })
  " 2>/dev/null
}

cleanup_rehearsal() {
  docker rm -f "mareo-rehearsal-${STAMP}" >/dev/null 2>&1 || true
  rm -f "/tmp/mareo-rehearsal-${STAMP}.db"
}
trap cleanup_rehearsal EXIT

# ---------------------------------------------------------------- 1. back up
log "备份数据库与源码"
docker compose exec -T gateway node -e "
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(process.env.DB_PATH ?? 'data/mareo.db')
  db.prepare('VACUUM INTO ?').run('backups/deploy-${STAMP}.db')
  db.close()
" 2>/dev/null || fail "数据库备份失败，中止"
cp -a ../src "../src.bak-${STAMP}"
log "备份：backups/deploy-${STAMP}.db · src.bak-${STAMP}"

# ----------------------------------------------------------------- 2. build
log "构建镜像"
docker compose build gateway 2>&1 | tail -1

# ------------------------------------------------------- 3. rehearse migration
# The whole point: this container may fail. If it does, nothing has changed.
log "预演：用生产库副本跑一次迁移（线上不受影响）"
cp data/mareo.db "/tmp/mareo-rehearsal-${STAMP}.db"
chown 1000:1000 "/tmp/mareo-rehearsal-${STAMP}.db" 2>/dev/null || true
docker run -d --name "mareo-rehearsal-${STAMP}" \
  --env-file .env \
  -e TZ=Asia/Shanghai \
  -e DB_PATH=/app/data/rehearsal.db \
  -v "/tmp/mareo-rehearsal-${STAMP}.db:/app/data/rehearsal.db" \
  -v "$PWD/secrets:/app/secrets:ro" \
  -p "127.0.0.1:${REHEARSAL_PORT}:3000" \
  mareo-gateway:local >/dev/null

if ! wait_healthy "mareo-rehearsal-${STAMP}"; then
  log "预演容器的日志："
  docker logs --tail 30 "mareo-rehearsal-${STAMP}" 2>&1 | sed 's/^/    /'
  fail "预演失败：这个镜像无法迁移生产库。线上未改动。"
fi
log "预演通过：迁移能跑通，容器能起来"

# --------------------------------------------------- 4. start the new instance
log "启动新实例（${NEXT_PORT} 端口，尚未接流量）"
docker compose --profile next up -d gateway-next 2>&1 | tail -1
if ! wait_healthy mareo-gateway-gateway-next-1; then
  log "新实例的日志："
  docker compose --profile next logs --tail 30 gateway-next 2>&1 | sed 's/^/    /'
  docker compose --profile next stop gateway-next >/dev/null 2>&1 || true
  fail "新实例启动失败。线上仍在 ${CURRENT_PORT} 提供服务。"
fi
probe "$NEXT_PORT" || { docker compose --profile next stop gateway-next >/dev/null 2>&1 || true; fail "新实例读不到数据，中止"; }

# ------------------------------------------------------------- 5. switch nginx
log "切换 nginx 指向 ${NEXT_PORT}"
sed -i.bak-"${STAMP}" "s/127\.0\.0\.1:${CURRENT_PORT}/127.0.0.1:${NEXT_PORT}/" "$NGINX_CONF"
if ! nginx -t >/dev/null 2>&1; then
  mv "${NGINX_CONF}.bak-${STAMP}" "$NGINX_CONF"
  docker compose --profile next stop gateway-next >/dev/null 2>&1 || true
  fail "nginx 配置校验失败，已还原"
fi
nginx -s reload

sleep 3
if ! curl -fsS -m 10 "${PUBLIC_URL}/health" >/dev/null; then
  log "外部健康检查失败，切回 ${CURRENT_PORT}"
  mv "${NGINX_CONF}.bak-${STAMP}" "$NGINX_CONF"
  nginx -s reload
  docker compose --profile next stop gateway-next >/dev/null 2>&1 || true
  fail "已切回旧实例，外部健康检查未通过"
fi
log "外部验证通过"

# ---------------------------------------------------------------- 6. retire old
log "停止旧实例（${CURRENT_PORT}）"
docker compose stop gateway 2>&1 | tail -1
log "完成：网关现在新实例上运行"
log "回滚方法：cp ${NGINX_CONF}.bak-${STAMP} ${NGINX_CONF} && nginx -s reload && docker compose --profile next stop gateway-next"
