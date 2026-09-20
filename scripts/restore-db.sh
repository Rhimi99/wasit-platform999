#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — Database Restore Script
# Restores wasit_dev (and optionally wasit_test) + globals from a backup folder.
#
# Usage:
#   ./scripts/restore-db.sh ./backups/20260914T135000Z
#   ./scripts/restore-db.sh ./backups/20260914T135000Z --with-test
#
# Requires: PostgreSQL client tools + sudo access to the postgres OS user.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
export PATH="$PG_BIN:$PATH"

BACKUP_DIR="${1:?Usage: restore-db.sh <backup-dir> [--with-test]}"
WITH_TEST="${2:-}"
DB_DEV="postgresql://wasit:wasit_dev_password@localhost:5432/wasit_dev"
DB_TEST="postgresql://wasit:wasit_dev_password@localhost:5432/wasit_test"
DEV_DUMP="$BACKUP_DIR/wasit_dev.dump"
TEST_DUMP="$BACKUP_DIR/wasit_test.dump"
GLOBALS_SQL="$BACKUP_DIR/pg_globals.sql"

# 1. Restore globals (roles)
if [ -f "$GLOBALS_SQL" ]; then
  echo "== Restoring globals from $GLOBALS_SQL"
  sudo -u postgres psql -f "$GLOBALS_SQL"
fi

# 2. Recreate + restore wasit_dev
echo "== Recreating wasit_dev (idempotent: drop only this DB)"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS wasit_dev;"
sudo -u postgres psql -c "CREATE DATABASE wasit_dev OWNER wasit;"
echo "== Restoring wasit_dev from $DEV_DUMP"
pg_restore --no-owner --role=wasit -d "$DB_DEV" "$DEV_DUMP"

# 3. Optional: wasit_test
if [ "$WITH_TEST" = "--with-test" ] && [ -f "$TEST_DUMP" ]; then
  echo "== Recreating wasit_test"
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS wasit_test;"
  sudo -u postgres psql -c "CREATE DATABASE wasit_test OWNER wasit;"
  echo "== Restoring wasit_test from $TEST_DUMP"
  pg_restore --no-owner --role=wasit -d "$DB_TEST" "$TEST_DUMP"
fi

echo "== Restore complete."