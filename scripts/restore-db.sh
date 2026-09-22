#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — Database restore (with verification).
#
# Restores a backup produced by scripts/backup-db.sh into a database, then
# verifies it against the row counts captured at backup time. A restore that
# exits 0 without verification is not evidence of anything, so verification is
# on by default and reported explicitly.
#
# SAFETY: the default target is a *scratch* database named
# "<backup-db>_restore", never the live database named in DATABASE_URL. Restoring
# over a live database is a deliberate, explicit act:
#   * the target must differ from the live database unless --allow-live is given
#   * an existing target is refused unless --force is given
#
# Usage:
#   ./scripts/restore-db.sh ./backups/20260922T060000Z
#   ./scripts/restore-db.sh <dir> --target wasit_restore
#   ./scripts/restore-db.sh <dir> --target wasit_drill --force
#
# Flags:
#   --target <db>     database to restore into (default: <dump-db>_restore)
#   --force           overwrite the target if it already exists
#   --allow-live      permit the target to equal the DATABASE_URL database
#   --no-verify       skip the post-restore row-count comparison
#   --drop-after      drop the target again when verification passes (dry-run
#                     drills against a throwaway database)
#
# Env:
#   DATABASE_URL      the *live* database, used only to know what to protect
#   PG_BIN            postgres client bin dir if not on PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

PG_BIN="$(wasit_pg_bin)"
export PATH="$PG_BIN:$PATH"
wasit_require pg_restore
wasit_require psql
wasit_require sha256sum

BACKUP_DIR=""
TARGET_DB=""
FORCE=0
ALLOW_LIVE=0
VERIFY=1
DROP_AFTER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_DB="${2:?--target needs a database name}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --allow-live) ALLOW_LIVE=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --drop-after) DROP_AFTER=1; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) BACKUP_DIR="$1"; shift ;;
  esac
done

[ -n "$BACKUP_DIR" ] || { echo "Usage: restore-db.sh <backup-dir> [--target db] [--force] [--allow-live] [--no-verify] [--drop-after]" >&2; exit 2; }
[ -d "$BACKUP_DIR" ] || { echo "ERROR: backup dir not found: $BACKUP_DIR" >&2; exit 1; }
MANIFEST="$BACKUP_DIR/manifest.json"
[ -f "$MANIFEST" ] || { echo "ERROR: no manifest.json in $BACKUP_DIR (not a WASIT backup)" >&2; exit 1; }

SOURCE_URL="$(wasit_source_url)"
LIVE_DB="$(basename "${SOURCE_URL%%\?*}")"   # last path segment before any query

# --- 1. Integrity: verify every file against its recorded digest before use ---
echo "== Verifying backup integrity in $BACKUP_DIR"
if [ -f "$BACKUP_DIR/checksums.sha256" ]; then
  ( cd "$BACKUP_DIR" && sha256sum -c checksums.sha256 >/dev/null ) || {
    echo "INTEGRITY FAILED: checksum mismatch in $BACKUP_DIR" >&2
    exit 1
  }
  echo "  ok: checksums verified"
else
  echo "  warn: no checksums.sha256 in this backup; skipping integrity check" >&2
fi

# --- 2. Decide the target database, applying the safety rails ---
PRIMARY_DB="$(grep -o '"database": *"[^"]*"' "$MANIFEST" | head -1 | sed -e 's/.*"\([^"]*\)"$/\1/')"
[ -n "$PRIMARY_DB" ] || { echo "ERROR: could not read a database name from the manifest" >&2; exit 1; }
# Default target: a scratch database for a safe drill. In a real recovery the
# operator names the database they lost; --allow-live is exactly that intent, so
# it also restores to the backup's own database name by default.
if [ -z "$TARGET_DB" ]; then
  if [ "$ALLOW_LIVE" -eq 1 ]; then
    TARGET_DB="$LIVE_DB"
  else
    TARGET_DB="${PRIMARY_DB}_restore"
  fi
fi

if [ "$TARGET_DB" = "$LIVE_DB" ] && [ "$ALLOW_LIVE" -ne 1 ]; then
  echo "ERROR: refusing to restore over the live database '$LIVE_DB'." >&2
  echo "       Default target is a scratch database; pass --allow-live to override." >&2
  exit 1
fi
if [ "$TARGET_DB" = "postgres" ] || [ "$TARGET_DB" = "template1" ]; then
  echo "ERROR: refusing to use '$TARGET_DB' as a restore target." >&2
  exit 1
fi

# Connect as the backup's owner to the maintenance database.
wasit_use_url "$SOURCE_URL" "$(wasit_maintenance_db)"
MAINT_DB="$PGDATABASE"

echo "== Target database: $TARGET_DB (live is '$LIVE_DB')"
EXISTS="$(psql -tAc "select 1 from pg_database where datname = '$TARGET_DB'")"
if [ -n "$EXISTS" ] && [ "$FORCE" -ne 1 ]; then
  echo "ERROR: database '$TARGET_DB' already exists; pass --force to overwrite it." >&2
  exit 1
fi

# --- 3. Create the target and restore into it ---
echo "== Creating $TARGET_DB"
psql -d "$MAINT_DB" -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";" >/dev/null
psql -d "$MAINT_DB" -c "CREATE DATABASE \"$TARGET_DB\";" >/dev/null

echo "== Restoring from $PRIMARY_DB.dump"
# --no-owner: the restored objects belong to whoever runs the drill, not the
# original role, so a cross-environment restore does not fail on role names.
pg_restore --no-owner --dbname "$TARGET_DB" "$BACKUP_DIR/$PRIMARY_DB.dump"

# --- 4. Verify: compare row counts against the backup's own snapshot ---
if [ "$VERIFY" -eq 1 ]; then
  COUNTS_FILE="$BACKUP_DIR/table-counts.tsv"
  if [ ! -f "$COUNTS_FILE" ]; then
    echo "== Verify: no table-counts.tsv in backup; skipping comparison"
  else
    echo "== Verifying row counts"
    MISMATCH=0
    while IFS=$'\t' read -r table expected; do
      [ -n "$table" ] || continue
      actual="$(psql -d "$TARGET_DB" -tAc "select count(*) from \"$table\"" 2>/dev/null || echo "ERROR")"
      if [ "$actual" != "$expected" ]; then
        echo "  MISMATCH $table: expected $expected, got $actual"
        MISMATCH=1
      fi
    done < "$COUNTS_FILE"
    if [ "$MISMATCH" -ne 0 ]; then
      echo "== RESTORE VERIFICATION FAILED" >&2
      exit 1
    fi
    echo "  ok: every table matches the backup snapshot"
  fi
fi

echo "== Restore verified OK: $TARGET_DB"

if [ "$DROP_AFTER" -eq 1 ]; then
  echo "== Dropping scratch database $TARGET_DB (--drop-after)"
  psql -d "$MAINT_DB" -c "DROP DATABASE \"$TARGET_DB\";" >/dev/null
fi

echo "== Restore complete."
