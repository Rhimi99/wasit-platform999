#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — shared helpers for backup/restore scripts.
#
# Sourced, never executed. Provides non-interactive PostgreSQL connection
# handling so backups can run unattended (cron/systemd) without a TTY to answer
# a password prompt — an interactive `pg_dump` in a timer just hangs.

set -euo pipefail

# Resolve the PostgreSQL client tools. A distro install keeps them under a
# versioned directory that is not always on PATH for a non-login shell.
wasit_pg_bin() {
  if [ -n "${PG_BIN:-}" ]; then
    echo "$PG_BIN"
    return
  fi
  if command -v pg_dump >/dev/null 2>&1; then
    dirname "$(command -v pg_dump)"
    return
  fi
  local candidate
  for candidate in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
    if [ -x "$candidate/pg_dump" ]; then
      echo "$candidate"
      return
    fi
  done
  echo "ERROR: pg_dump not found; set PG_BIN" >&2
  exit 1
}

# Connection string for the database the app writes to. Everything else is
# derived from it so a deployment configures one URL, not five variables.
wasit_source_url() {
  echo "${DATABASE_URL:-postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev}"
}

# Parse a postgresql:// URL into PG* environment variables. libpq then reads them
# and never prompts: with PGPASSWORD set, a wrong password fails fast instead of
# blocking on a TTY.
#
# Usage: wasit_use_url "$url" [dbname-override]
wasit_use_url() {
  local url="$1"
  local override_db="${2:-}"
  local rest="${url#*://}"
  local creds hostpart
  if [[ "$rest" == *"@"* ]]; then
    creds="${rest%%@*}"
    hostpart="${rest#*@}"
  else
    creds=""
    hostpart="$rest"
  fi

  export PGUSER="${creds%%:*}"
  if [[ "$creds" == *":"* ]]; then
    export PGPASSWORD="${creds#*:}"
  else
    # No password in the URL: keep whatever the environment already supplied
    # (e.g. a .pgpass-backed deployment) rather than forcing an empty one.
    : "${PGPASSWORD:=}"
    export PGPASSWORD
  fi
  [ -n "$PGUSER" ] || export PGUSER=postgres

  # host[:port]/dbname?params — drop query params and any path beyond the dbname.
  local hp="${hostpart%%/*}"
  local db="${hostpart#*/}"
  db="${db%%\?*}"
  export PGHOST="${hp%%:*}"
  if [[ "$hp" == *":"* ]]; then
    export PGPORT="${hp#*:}"
  else
    export PGPORT=5432
  fi
  [ -n "$PGHOST" ] || export PGHOST=localhost

  if [ -n "$override_db" ]; then
    export PGDATABASE="$override_db"
  else
    export PGDATABASE="${db:-postgres}"
  fi
}

# The maintenance database used to DROP/CREATE other databases. `postgres`
# always exists; connecting to the target we are about to drop would not work.
wasit_maintenance_db() {
  echo "${PGMAINTENANCE_DB:-postgres}"
}

wasit_require() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: required tool '$tool' not found in PATH" >&2
    exit 1
  }
}

# Timestamped, sortable backup folder name (UTC).
wasit_stamp() {
  date -u +%Y%m%dT%H%M%SZ
}
