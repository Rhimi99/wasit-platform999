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

# --- Database-name safety ---------------------------------------------------
# Used by restore-db.sh before any name reaches SQL or a PostgreSQL command.

# Validate a database name against the conservative shape the project uses.
# A name that fails is refused outright — never escaped and used anyway — so a
# hostile name cannot reach a DROP/CREATE DATABASE statement.
wasit_validate_db_name() {
  local name="$1" label="${2:-database name}"
  if [ -z "$name" ]; then
    echo "ERROR: $label is empty" >&2
    return 1
  fi
  if [ "${#name}" -gt 63 ]; then
    echo "ERROR: $label '$name' is longer than 63 characters" >&2
    return 1
  fi
  case "$name" in
    [a-z]*)
      case "$name" in
        *[!a-z0-9_]*)
          echo "ERROR: $label '$name' contains disallowed characters (allowed: a-z, 0-9, _)" >&2
          return 1
          ;;
      esac
      ;;
    *)
      echo "ERROR: $label '$name' must start with a lower-case letter" >&2
      return 1
      ;;
  esac
  return 0
}

# Quote a PostgreSQL identifier. Doubling an embedded double quote is the
# documented rule; it is belt-and-braces here because wasit_validate_db_name
# already forbids quotes.
wasit_sql_ident() {
  local ident="$1"
  printf '"%s"' "${ident//\"/\"\"}"
}

# Databases that must never be a restore target. Sourced from the project, not
# invented: docs/DEPLOYMENT.md (environment table), .env.demo,
# .env.staging.example and scripts/demo-security-smoke.sh. `postgres`,
# `template0` and `template1` are PostgreSQL's own system databases.
wasit_protected_db_names() {
  cat <<'NAMES'
wasit_prod
wasit_staging
wasit_demo
postgres
template0
template1
NAMES
}

# Operator-supplied additions, comma/space/semicolon separated. Additive only:
# an unparseable list never removes a built-in name. Always newline-terminated
# so the last entry is not dropped by a `while read` consumer.
wasit_extra_protected_names() {
  printf '%s\n' "${WASIT_PROTECTED_DB_NAMES:-}" | tr ',;' '\n' | tr -s '[:space:]' '\n'
}

# True (0) when the name — or its scratch alias, a trailing `_restore`/`_drill` —
# matches a protected database. Case-insensitive.
wasit_is_protected_db_name() {
  local name lower base candidate
  name="$1"
  lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  base="${lower%_restore}"
  base="${base%_drill}"
  while IFS= read -r candidate || [ -n "$candidate" ]; do
    [ -n "$candidate" ] || continue
    if [ "$lower" = "$candidate" ] || [ "$base" = "$candidate" ]; then
      return 0
    fi
  done < <(wasit_protected_db_names; wasit_extra_protected_names)
  return 1
}

# Create a directory with an explicit, restrictive mode — never relying on the
# inherited umask. Only the given path is touched; its parents are left alone.
wasit_secure_dir() {
  local dir="$1" mode="${2:-0700}"
  mkdir -p "$dir"
  chmod "$mode" "$dir"
}

# --- Backup encryption (age) ------------------------------------------------
# Optional at-rest encryption of the payload files. `off` is the default and
# leaves the current behaviour untouched; `age` encrypts every payload file with
# an X25519 recipient. The private identity never reaches this code as an
# argument value — only as a path — so it cannot leak through `ps`.

# Resolve the age binary. Absent is not an error here: only the `age` mode
# requires it, and the caller decides when that matters.
wasit_age_bin() {
  if [ -n "${BACKUP_AGE_BIN:-}" ]; then
    echo "$BACKUP_AGE_BIN"
    return 0
  fi
  command -v age 2>/dev/null || true
}

# Resolve the recipients list: inline value, then file. Missing recipients is
# not an error here; wasit_require_age reports it when encryption is requested.
# The inline form may separate recipients with any whitespace (spaces, tabs or
# newlines); the file form is one recipient per line.
wasit_age_recipients() {
  if [ -n "${BACKUP_AGE_RECIPIENTS:-}" ]; then
    printf '%s\n' "$BACKUP_AGE_RECIPIENTS" | tr '[:blank:]' '\n'
  elif [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ] && [ -f "$BACKUP_AGE_RECIPIENTS_FILE" ]; then
    cat "$BACKUP_AGE_RECIPIENTS_FILE"
  fi
}

# Fail (exit) unless the age tool and at least one recipient are present, and
# every configured recipient is one that age itself accepts. Called before any
# backup/restore work so a misconfiguration stops the run before a database is
# touched.
#
# Validation is not a regex: each recipient is handed to age's own parser, which
# verifies the key type and its Bech32 checksum. A recipient that merely looks
# like "age1..." but has a corrupted or truncated body is therefore rejected. The
# probe encrypts empty input to /dev/null, so it is a pure parse with no output
# and no state.
wasit_require_age() {
  local bin recipients r err
  bin="$(wasit_age_bin)"
  if [ -z "$bin" ] || [ ! -x "$bin" ]; then
    echo "ERROR: BACKUP_ENCRYPTION=age requires the 'age' tool (set BACKUP_AGE_BIN or install it)" >&2
    exit 1
  fi
  recipients="$(wasit_age_recipients | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' | grep -v '^#' || true)"
  if [ -z "$recipients" ]; then
    echo "ERROR: BACKUP_ENCRYPTION=age requires at least one age recipient (BACKUP_AGE_RECIPIENTS or BACKUP_AGE_RECIPIENTS_FILE)" >&2
    exit 1
  fi
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    if ! err="$(printf '' | "$bin" --encrypt -r "$r" -o /dev/null 2>&1)"; then
      echo "ERROR: BACKUP_ENCRYPTION=age received an invalid recipient ('$r'): ${err:-rejected by age}; refusing before any database work" >&2
      exit 1
    fi
  done <<< "$recipients"
}

# The recipients as age CLI args (one -r per recipient). Read from the resolved
# list so both the inline and file forms are handled in one place.
wasit_age_recipient_args() {
  local r
  while IFS= read -r r; do
    case "$r" in
      ''|'#'*) continue ;;
    esac
    printf '%s\0' -r "$r"
  done < <(wasit_age_recipients)
}

# Resolve the private identity *path* (never its contents). It must live outside
# the backup directory; the caller enforces that boundary.
wasit_age_identity_path() {
  echo "${BACKUP_AGE_IDENTITY_FILE:-}"
}
