#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — Database Backup Script
# Creates a full pg_dump (custom format) of wasit_dev + wasit_test + globals
# into a timestamped folder under PROJECT_ROOT/backups.
#
# Usage:  ./scripts/backup-db.sh
# Requires: PostgreSQL client tools (pg_dump / pg_dumpall) in PATH or PG_BIN.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_ROOT/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$BACKUP_ROOT/$STAMP"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
DB_API="postgresql://wasit:wasit_dev_password@localhost:5432"

export PATH="$PG_BIN:$PATH"

mkdir -p "$OUT_DIR"

echo "== Backup directory: $OUT_DIR"
"$PG_BIN/pg_dump"  -h localhost -U wasit -d wasit_dev  -Fc -f "$OUT_DIR/wasit_dev.dump"
"$PG_BIN/pg_dump"  -h localhost -U wasit -d wasit_test -Fc -f "$OUT_DIR/wasit_test.dump"
sudo -u postgres "$PG_BIN/pg_dumpall" --globals-only > "$OUT_DIR/pg_globals.sql"

echo "== Listing:"
ls -lh "$OUT_DIR"
echo "== Backup complete."