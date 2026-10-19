#!/usr/bin/env bash
# Regenerates the operations pages (https://mareo.cn/stats/, behind the nginx
# password gate) from the gateway database. Run from server/deploy:
#
#   */15 * * * * cd /srv/mareo/server/deploy && ./stats-page.sh >> backups/stats.log 2>&1
#
# Two pages, two audiences: the business dashboard and the engineering health
# page. They are static snapshots on purpose — the database stays unreachable
# from the internet, and a failed generation leaves the previous page in place.
set -euo pipefail
cd "$(dirname "$0")"

site_dir=/var/www/mareo-site/stats

# Download requests come from the web server log; the OSS counters need
# credentials the gateway does not have, so the page reports requests.
downloads="$(grep -ho 'GET /downloads/[^ ]*' /var/log/nginx/access.log* 2>/dev/null | wc -l | tr -d ' ' || echo 0)"

publish() {
  local page=$1
  local target=$2
  local tmp
  tmp="$(mktemp)"
  # Each page renders to a temp file and is moved into place only when complete.
  docker compose exec -T gateway node dist/src/stats-page.js --page "$page" --downloads "$downloads" > "$tmp"
  mkdir -p "$(dirname "$target")"
  chmod 644 "$tmp"
  mv "$tmp" "$target"
}

publish ceo "$site_dir/index.html"
publish health "$site_dir/health/index.html"
echo "$(date -Is) stats pages regenerated (downloads=$downloads)"
