#!/usr/bin/env bash
#
# Deploy the gateway without ever taking it down for a bug we could have caught.
#
# The rule this script exists to enforce: a build must prove it can migrate the
# real database *before* it is allowed to serve traffic. On 2026-10-24 a
# migration added a column after creating its index; the gateway restarted
# fifteen times and the API returned 502 for ten minutes. The agent that deployed
# it could not repair it, because its own model calls go through the gateway it
# had just broken.
#
# Order:
#   1. back up database and source
#   2. build the image
#   3. rehearse the migration on a COPY of the database, in an isolated container
#   4. start the new build in the *idle* slot, still receiving no traffic
#   5. point nginx at it, reload, verify from outside
#   6. stop the old slot
#
# Deploys alternate between two slots (3000/gateway and 3001/gateway-next): the
# slot nginx points at keeps serving while the other is rebuilt. A failure before
# step 5 leaves the running gateway untouched; a failure at or after step 5 points
# nginx back.
#
# Only table/column additions may be deployed this way. A migration that drops or
# retypes anything must be done in a maintenance window with the gateway stopped,
# because two versions cannot share one SQLite file across that change.
set -euo pipefail

cd "$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
REHEARSAL_PORT=3011
NGINX_CONF="/etc/nginx/conf.d/mareo-gateway.conf"
PUBLIC_URL="${PUBLIC_URL:-https://api.svc.mareo.cn}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
COMPOSE="docker compose --profile next"

log() { echo "[deploy] $*"; }
fail() { echo "[deploy] ✗ $*" >&2; exit 1; }

if ! grep -qE '127\.0\.0\.1:(3000|3001)' "$NGINX_CONF"; then
  fail "在 ${NGINX_CONF} 里找不到 3000 或 3001，无法判断当前在哪个槽位"
fi
if grep -q '127\.0\.0\.1:3000' "$NGINX_CONF"; then
  CURRENT_PORT=3000; CURRENT_SERVICE=gateway
  TARGET_PORT=3001;  TARGET_SERVICE=gateway-next
else
  CURRENT_PORT=3001; CURRENT_SERVICE=gateway-next
  TARGET_PORT=3000;  TARGET_SERVICE=gateway
fi
TARGET_CONTAINER="mareo-gateway-${TARGET_SERVICE}-1"
log "当前 ${CURRENT_PORT}（${CURRENT_SERVICE}）在服务；新实例将占用 ${TARGET_PORT}（${TARGET_SERVICE}）"

# Waits until a container reports healthy, or gives up.
wait_healthy() {
  local name="$1" waited=0 state
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
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

# A container that is up is not the same as a container that works: ask the new
# instance itself to read real rows through the schema it just migrated.
probe() {
  local port="$1" container="$2"
  curl -fsS -m 5 "http://127.0.0.1:${port}/health" >/dev/null || return 1
  docker exec "$container" node -e "
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.env.DB_PATH ?? 'data/mareo.db')
    const version = db.prepare('PRAGMA user_version').get().user_version
    const accounts = db.prepare('SELECT COUNT(*) n FROM users').get().n
    db.close()
    if (!Number.isInteger(version) || accounts < 1) process.exit(1)
    console.log('[deploy] schema v' + version + ', ' + accounts + ' 个账号可读')
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

# --------------------------------------------------- 4. start in the idle slot
log "在 ${TARGET_PORT} 启动新实例（尚未接流量）"
$COMPOSE stop "$TARGET_SERVICE" >/dev/null 2>&1 || true
$COMPOSE up -d "$TARGET_SERVICE" 2>&1 | tail -1
if ! wait_healthy "$TARGET_CONTAINER"; then
  log "新实例的日志："
  $COMPOSE logs --tail 30 "$TARGET_SERVICE" 2>&1 | sed 's/^/    /'
  $COMPOSE stop "$TARGET_SERVICE" >/dev/null 2>&1 || true
  fail "新实例启动失败。线上仍在 ${CURRENT_PORT} 提供服务。"
fi
probe "$TARGET_PORT" "$TARGET_CONTAINER" || {
  $COMPOSE stop "$TARGET_SERVICE" >/dev/null 2>&1 || true
  fail "新实例读不到数据，中止。线上仍在 ${CURRENT_PORT} 提供服务。"
}
log "新实例健康，且能读到数据"

# ------------------------------------------------------------- 5. switch nginx
log "切换 nginx 指向 ${TARGET_PORT}"
sed -i.bak-"${STAMP}" "s/127\.0\.0\.1:${CURRENT_PORT}/127.0.0.1:${TARGET_PORT}/" "$NGINX_CONF"
if ! nginx -t >/dev/null 2>&1; then
  mv "${NGINX_CONF}.bak-${STAMP}" "$NGINX_CONF"
  $COMPOSE stop "$TARGET_SERVICE" >/dev/null 2>&1 || true
  fail "nginx 配置校验失败，已还原，线上未改动"
fi
nginx -s reload

sleep 3
if ! curl -fsS -m 10 "${PUBLIC_URL}/health" >/dev/null; then
  log "外部健康检查失败，切回 ${CURRENT_PORT}"
  mv "${NGINX_CONF}.bak-${STAMP}" "$NGINX_CONF"
  nginx -s reload
  $COMPOSE stop "$TARGET_SERVICE" >/dev/null 2>&1 || true
  fail "已切回旧实例，外部健康检查未通过"
fi
log "外部验证通过"

# ---------------------------------------------------------------- 6. retire old
log "停止旧实例（${CURRENT_PORT}）"
$COMPOSE stop "$CURRENT_SERVICE" 2>&1 | tail -1
log "完成：现在 ${TARGET_PORT}（${TARGET_SERVICE}）在服务"
log "回滚：cp ${NGINX_CONF}.bak-${STAMP} ${NGINX_CONF} && nginx -s reload && ${COMPOSE} stop ${TARGET_SERVICE} && ${COMPOSE} start ${CURRENT_SERVICE}"
