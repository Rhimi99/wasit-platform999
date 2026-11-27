#!/usr/bin/env bash
# Demo health gate: database, API, web preview, public URL and the proxy path.
# Exit code 0 only when every layer answers. No credentials are printed.
#
#   bash scripts/demo-health.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f .env.demo ] || { echo "ERROR: .env.demo is missing" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env.demo; set +a
: "${PORT:=3000}"
: "${WEB_PORT:=12000}"
: "${APP_URL:=http://localhost:$WEB_PORT}"

fail=0
report() {
  local name="$1" code="$2"
  if [ "$code" = "200" ]; then printf '  OK    %-34s %s\n' "$name" "$code"; else printf '  FAIL  %-34s %s\n' "$name" "$code"; fail=1; fi
}

DB_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')"
DB_PORT="$(printf '%s' "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')"
PGBIN="${PG_BIN:-$(dirname "$(ls -d /usr/lib/postgresql/*/bin/pg_isready 2>/dev/null | head -1)" 2>/dev/null)}"
if "${PGBIN:+$PGBIN/}pg_isready" -h "$DB_HOST" -p "${DB_PORT:-5432}" >/dev/null 2>&1; then
  report "postgres $DB_HOST:${DB_PORT:-5432}" 200
else
  report "postgres $DB_HOST:${DB_PORT:-5432}" down
fi

for path in /api/health/live /api/health/ready /api/health/channels; do
  report "local $path" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT$path")"
done
report "local web :$WEB_PORT" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$WEB_PORT/")"
report "local proxy /api/health/ready" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$WEB_PORT/api/health/ready")"

case "$APP_URL" in
  http*)
    report "public $APP_URL" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$APP_URL/")"
    report "public /api/health/ready" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$APP_URL/api/health/ready")"
    ;;
esac

exit "$fail"
