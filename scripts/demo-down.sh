#!/usr/bin/env bash
# Stop the API and web preview started by scripts/demo-up.sh.
# PostgreSQL is left running: other databases on the same cluster may be in use.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
RUN_DIR=".demo-run"

stop_pid() {
  local file="$RUN_DIR/$1.pid" name="$2" pid
  [ -f "$file" ] || { echo "  no pidfile for $name"; return; }
  pid="$(cat "$file" 2>/dev/null)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "  stopped $name (pid $pid)"
  else
    echo "  $name not running"
  fi
  rm -f "$file"
}

# Fallback for processes started outside the script: match this checkout's own
# command lines only, never a generic "node" pattern.
stop_by_pattern() {
  local pattern="$1" name="$2" pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ')"
  [ -z "${pids// /}" ] && return
  echo "  stopping $name without pidfile: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  sleep 2
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null
}

stop_pid web "web preview"
stop_pid api "api"

ROOT="$(pwd)"
stop_by_pattern "node $ROOT/node_modules/.bin/vite preview --port" "web preview"
stop_by_pattern "tsx src/index.ts" "api"
