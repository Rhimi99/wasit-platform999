#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — Database backup.
#
# Produces a timestamped, self-describing backup folder:
#   <BACKUP_ROOT>/<UTC-stamp>/
#     <dbname>.dump      custom-format pg_dump (restore with pg_restore)
#     pg_globals.sql     roles/tablespaces (restore with psql)
#     manifest.json      sizes + sha256 so a restore can verify first
#
# Safe to run unattended (cron/systemd): the connection is taken from
# DATABASE_URL and exported as PGPASSWORD, so libpq never opens a password
# prompt that would hang a timer. Overlapping runs are serialised with flock.
#
# Usage:
#   ./scripts/backup-db.sh
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/backup-db.sh
#
# Env:
#   DATABASE_URL            source database (default: local wasit_dev)
#   BACKUP_ROOT             where to write (default: <repo>/backups)
#   BACKUP_INCLUDE_TEST_DB  "true" to also dump TEST_DATABASE_URL
#   BACKUP_RETENTION_COUNT  how many recent folders to keep (default 7, 0 = all)
#   PG_BIN                  postgres client bin dir if not on PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

PG_BIN="$(wasit_pg_bin)"
export PATH="$PG_BIN:$PATH"
wasit_require pg_dump
wasit_require pg_dumpall
wasit_require sha256sum

BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_ROOT/backups}"
RETENTION="${BACKUP_RETENTION_COUNT:-7}"
SOURCE_URL="$(wasit_source_url)"
STAMP="$(wasit_stamp)"
OUT_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$BACKUP_ROOT"
LOCK_FILE="$BACKUP_ROOT/.backup.lock"
# Serialise: a long dump and the next scheduled run must not interleave and
# prune each other's in-progress folder.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "== Another backup is already running; exiting." >&2
  exit 0
fi

mkdir -p "$OUT_DIR"

# A partial failure must not leave a folder that looks like a valid backup, so
# the trap removes it unless we explicitly finished.
COMPLETE=0
cleanup() {
  if [ "$COMPLETE" -ne 1 ]; then
    echo "== Backup failed; removing incomplete folder $OUT_DIR" >&2
    rm -rf "$OUT_DIR"
  fi
}
trap cleanup EXIT

echo "== Backup directory: $OUT_DIR"

wasit_use_url "$SOURCE_URL"
PRIMARY_DB="$PGDATABASE"
echo "== Dumping $PRIMARY_DB from $PGHOST:$PGPORT"
pg_dump -Fc -f "$OUT_DIR/$PRIMARY_DB.dump"

DB_ENTRIES="{\"database\":\"$PRIMARY_DB\",\"file\":\"$PRIMARY_DB.dump\"}"

# Optional second database (e.g. the test DB next to dev).
if [ "${BACKUP_INCLUDE_TEST_DB:-false}" = "true" ]; then
  TEST_URL="${TEST_DATABASE_URL:-postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test}"
  wasit_use_url "$TEST_URL"
  echo "== Dumping $PGDATABASE (secondary)"
  pg_dump -Fc -f "$OUT_DIR/$PGDATABASE.dump"
  DB_ENTRIES="$DB_ENTRIES,{\"database\":\"$PGDATABASE\",\"file\":\"$PGDATABASE.dump\"}"
  wasit_use_url "$SOURCE_URL"
fi

echo "== Dumping globals (roles)"
pg_dumpall --globals-only -f "$OUT_DIR/pg_globals.sql"

PG_VERSION="$(pg_dump --version | awk '{print $3}')"
SERVER_VERSION="$(psql -tAc 'show server_version' 2>/dev/null || echo unknown)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Per-table row counts, captured at backup time. A restore can then be *verified*
# — the restored database is compared against these numbers — even after the
# source is gone, which is the whole point of a disaster-recovery drill.
TABLE_COUNTS_FILE="$OUT_DIR/table-counts.tsv"
wasit_collect_table_counts() {
  local db="$1"
  local body
  body="$(PGDATABASE="$db" psql -tAc "
    select string_agg(
      format('select %L as t, count(*)::bigint as c from %I.%I', tablename, schemaname, tablename),
      ' union all ')
    from pg_tables where schemaname = 'public';")"
  if [ -z "$body" ]; then
    return 0
  fi
  PGDATABASE="$db" psql -tAF $'\t' -c "$body" | sort
}

wasit_collect_table_counts "$PRIMARY_DB" > "$TABLE_COUNTS_FILE"

# Build the manifest with real digests so restore can prove integrity.
{
  printf '{\n'
  printf '  "createdAt": "%s",\n' "$CREATED_AT"
  printf '  "postgresClientVersion": "%s",\n' "$PG_VERSION"
  printf '  "serverVersion": "%s",\n' "$SERVER_VERSION"
  printf '  "sourceHost": "%s",\n' "$PGHOST"
  printf '  "databases": [%s],\n' "$DB_ENTRIES"
  printf '  "tableCountsFile": "table-counts.tsv",\n'
  printf '  "files": {\n'
  first=1
  for f in "$OUT_DIR"/*.dump "$OUT_DIR/pg_globals.sql" "$TABLE_COUNTS_FILE"; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    digest="$(sha256sum "$f" | awk '{print $1}')"
    size="$(stat -c %s "$f")"
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    "%s": { "sha256": "%s", "bytes": %s }' "$name" "$digest" "$size"
  done
  printf '\n  }\n'
  printf '}\n'
} > "$OUT_DIR/manifest.json"

# A standard `sha256sum` file so restore can verify with `sha256sum -c` and no
# JSON parser (the restore may run from a slim image with only coreutils).
( cd "$OUT_DIR" && sha256sum ./*.dump ./pg_globals.sql ./*.tsv > checksums.sha256 )

# Heartbeat read by the API's `backup_stale` alert rule. Its absence or age is
# the only signal that a scheduled backup silently stopped running.
HEARTBEAT="${BACKUP_HEARTBEAT_FILE:-$BACKUP_ROOT/.last-success.json}"
printf '{"at":"%s","stamp":"%s","databases":[%s]}\n' "$CREATED_AT" "$STAMP" "$DB_ENTRIES" > "$HEARTBEAT"

COMPLETE=1

echo "== Listing:"
ls -lh "$OUT_DIR"

# Retention: keep the newest N folders. Names are UTC timestamps, so a lexical
# sort is chronological. Only folders that contain a manifest are considered,
# so an in-progress or failed run is never counted or deleted here.
if [ "${RETENTION:-0}" -gt 0 ] 2>/dev/null; then
  mapfile -t ALL < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '*Z' -exec test -f '{}/manifest.json' \; -print | sort)
  COUNT="${#ALL[@]}"
  if [ "$COUNT" -gt "$RETENTION" ]; then
    DELETE_COUNT=$((COUNT - RETENTION))
    echo "== Retention: keeping $RETENTION, pruning $DELETE_COUNT old backup(s)"
    for ((i = 0; i < DELETE_COUNT; i++)); do
      rm -rf "${ALL[$i]}"
    done
  fi
fi

echo "== Backup complete."
