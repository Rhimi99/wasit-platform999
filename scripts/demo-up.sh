#!/usr/bin/env bash
# Bring the public demo up: PostgreSQL check, API, web preview, health gate.
#
#   bash scripts/demo-up.sh            # start (builds the SPA if dist is missing)
#   bash scripts/demo-up.sh --build    # force a fresh VITE_DEMO_MODE build
#
# Reads everything from .env.demo (git-ignored). Never prints credentials.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

RUN_DIR=".demo-run"
mkdir -p "$RUN_DIR"

[ -f .env.demo ] || { echo "ERROR: .env.demo is missing (see docs/DEMO-01_PUBLIC_DEMO.md)" >&2; exit 1; }

# shellcheck disable=SC1091
set -a; . ./.env.demo; set +a
: "${PORT:=3000}"
: "${WEB_PORT:=12000}"
: "${APP_URL:=http://localhost:$WEB_PORT}"

wait_for() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null --max-time 2 "$url"; then echo "  up: $name"; return 0; fi
    sleep 1
  done
  echo "  FAILED: $name ($url)" >&2
  return 1
}

echo "== database =="
DB_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')"
DB_PORT="$(printf '%s' "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')"
DB_PORT="${DB_PORT:-5432}"
PGBIN="${PG_BIN:-$(dirname "$(ls -d /usr/lib/postgresql/*/bin/pg_isready 2>/dev/null | head -1)" 2>/dev/null)}"
ISREADY="${PGBIN:+$PGBIN/}pg_isready"
if "$ISREADY" -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; then
  echo "  up: $DB_HOST:$DB_PORT"
else
  echo "  PostgreSQL is not accepting connections on $DB_HOST:$DB_PORT" >&2
  echo "  start it first, e.g.: sudo pg_ctlcluster 17 main start" >&2
  exit 1
fi

echo "== api =="
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health/live"; then
  echo "  already running on :$PORT"
else
  ( cd packages/server && nohup npx tsx src/index.ts > "../../$RUN_DIR/api.log" 2>&1 & echo $! > "../../$RUN_DIR/api.pid" )
  wait_for "http://127.0.0.1:$PORT/api/health/ready" "api :$PORT" 60 || { tail -20 "$RUN_DIR/api.log"; exit 1; }
fi

echo "== web =="
if [ "${1:-}" = "--build" ] || [ ! -f packages/web/dist/index.html ]; then
  echo "  building SPA (VITE_DEMO_MODE=true)…"
  VITE_DEMO_MODE=true npm run build -w @wasit/web > "$RUN_DIR/build.log" 2>&1 \
    || { tail -20 "$RUN_DIR/build.log"; exit 1; }
fi
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$WEB_PORT/"; then
  echo "  already running on :$WEB_PORT"
else
  ( cd packages/web && nohup npx vite preview --port "$WEB_PORT" --host 0.0.0.0 > "../../$RUN_DIR/web.log" 2>&1 & echo $! > "../../$RUN_DIR/web.pid" )
  wait_for "http://127.0.0.1:$WEB_PORT/" "web :$WEB_PORT" 40 || { tail -20 "$RUN_DIR/web.log"; exit 1; }
fi

echo "== proxy =="
wait_for "http://127.0.0.1:$WEB_PORT/api/health/ready" "web → api proxy" 20 || exit 1

echo
echo "Demo is up: $APP_URL"
echo "Logs: $RUN_DIR/api.log, $RUN_DIR/web.log"
