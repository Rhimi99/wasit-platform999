#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — agent-video retention purge (scheduler entrypoint).
#
# This is the only supported way to run the purge in a deployment: systemd timer
# or cron calls this script. It is deliberately NOT wired into the Node process,
# because an in-process timer dies with the process and duplicates itself when a
# second instance starts.
#
# Properties:
#   - single-flight via flock: a second overlapping run exits 0 without working
#   - idempotent: the purge itself deletes only expired, classifiable files
#   - every run appends one JSON line to the log, failures included
#   - the exit code is the purge's (0 ok, 1 errors), so the scheduler can alert
#
# Usage: scripts/agent-video-purge.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${AGENT_VIDEO_PURGE_LOG:-$ROOT/logs/agent-video-purge.log}"
LOCK="${AGENT_VIDEO_PURGE_LOCK:-$ROOT/logs/.agent-video-purge.lock}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")"

# The scheduler does not inherit a login shell; load the deployment env when the
# caller did not already export DATABASE_URL.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  printf '{"job":"purge-agent-videos","ok":true,"skipped":"already_running","at":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
  exit 0
fi

cd "$ROOT/packages/server"
set +e
output="$(npx tsx src/scripts/purge-agent-videos.ts --json "$@" 2>&1)"
status=$?
set -e

# Keep the machine-readable line, plus any error text the script emitted.
printf '%s\n' "$output" | tail -n 1 >> "$LOG"
printf '%s\n' "$output" | tail -n 1
if [ "$status" -ne 0 ]; then
  printf '%s\n' "$output" >&2
fi
exit "$status"
