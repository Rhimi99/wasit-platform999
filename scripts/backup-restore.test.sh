#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — backup/restore drill test.
#
# Exercises the real scripts against a real PostgreSQL server. Every database it
# touches is a throwaway created here and dropped at the end: it never reads or
# writes the application's own databases.
#
# It asserts the properties that make a backup trustworthy, not just that the
# commands exit 0:
#   1. a backup runs unattended and records integrity digests + row counts
#   2. a restore reproduces the data and verifies it against the snapshot
#   3. a corrupted backup is refused
#   4. a restore over the live database is refused without --allow-live
#   5. after simulated data loss the backup recovers the database intact
#   6. retention prunes old backups, and a failed run leaves nothing behind
#
# Usage: ./scripts/backup-restore.test.sh
# Requires a PostgreSQL server reachable with the admin URL (default: local
# wasit_dev credentials) and the pg_dump/pg_restore/psql client tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

PG_BIN="$(wasit_pg_bin)"
export PATH="$PG_BIN:$PATH"

ADMIN_URL="${WASIT_TEST_ADMIN_URL:-postgresql://wasit:wasit_dev_password@localhost:5432/postgres}"
RUN_ID="drill_$$"
SRC_DB="${RUN_ID}_src"
RESTORE_DB="${RUN_ID}_restore"
TMP_ROOT="$(mktemp -d)"
BACKUP_ROOT="$TMP_ROOT/backups"
FAIL_ROOT="$TMP_ROOT/fail"
PASS=0
FAIL=0

cleanup() {
  wasit_use_url "$ADMIN_URL"
  for db in "$SRC_DB" "$RESTORE_DB" "${SRC_DB}_restore"; do
    psql -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 && \
      psql -c "DROP DATABASE IF EXISTS \"$db\";" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
expect_eq() { # expected actual label
  if [ "$1" = "$2" ]; then ok "$3 ($2)"; else bad "$3: expected '$1', got '$2'"; fi
}
expect_fail() { # label, then command
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$label (command unexpectedly succeeded)"; else ok "$label"; fi
}

wasit_use_url "$ADMIN_URL"
psql -tAc "select 1" >/dev/null || { echo "ERROR: cannot reach PostgreSQL at $ADMIN_URL" >&2; exit 1; }

say "Setup a throwaway source database"
psql -c "CREATE DATABASE \"$SRC_DB\";" >/dev/null
SRC_URL="$(python3 -c "
import sys
u = sys.argv[1]
head, _, tail = u.rpartition('/')
print(head + '/' + sys.argv[2])
" "$ADMIN_URL" "$SRC_DB")"
PGDATABASE="$SRC_DB" psql -tAc "
  CREATE TABLE users(id serial primary key, email text not null);
  INSERT INTO users(email) SELECT 'user-'||g||'@wasit.tn' FROM generate_series(1, 250) g;
  CREATE TABLE orders(id serial primary key, total_cents int not null);
  INSERT INTO orders(total_cents) SELECT g * 100 FROM generate_series(1, 40) g;
" >/dev/null
SRC_USERS="$(PGDATABASE="$SRC_DB" psql -tAc 'select count(*) from users')"
SRC_ORDERS="$(PGDATABASE="$SRC_DB" psql -tAc 'select count(*) from orders')"
expect_eq 250 "$SRC_USERS" "source users seeded"
expect_eq 40 "$SRC_ORDERS" "source orders seeded"

say "1. Backup runs unattended and records a manifest"
DATABASE_URL="$SRC_URL" BACKUP_ROOT="$BACKUP_ROOT" BACKUP_RETENTION_COUNT=0 \
  "$SCRIPT_DIR/backup-db.sh" >/dev/null
BK="$(ls -d "$BACKUP_ROOT"/*Z | head -1)"
[ -f "$BK/manifest.json" ] && ok "manifest.json written" || bad "manifest.json missing"
[ -f "$BK/table-counts.tsv" ] && ok "table-counts.tsv written" || bad "table-counts.tsv missing"
grep -q '"sha256"' "$BK/manifest.json" && ok "digests recorded" || bad "no sha256 in manifest"
COUNT_FOR_USERS="$(awk -F'\t' '$1=="users"{print $2}' "$BK/table-counts.tsv")"
expect_eq 250 "$COUNT_FOR_USERS" "snapshot row count for users"

say "2. Restore reproduces the data and verifies it"
DATABASE_URL="$SRC_URL" "$SCRIPT_DIR/restore-db.sh" "$BK" --target "$RESTORE_DB" >/dev/null
RESTORED="$(PGDATABASE="$RESTORE_DB" psql -tAc 'select count(*) from users')"
expect_eq 250 "$RESTORED" "restored users row count"
RESTORED_ORDERS="$(PGDATABASE="$RESTORE_DB" psql -tAc 'select count(*) from orders')"
expect_eq 40 "$RESTORED_ORDERS" "restored orders row count"

say "3. A corrupted backup is refused before restoring"
DUMP_FILE="$(ls "$BK"/*.dump | head -1)"
cp "$DUMP_FILE" "$TMP_ROOT/good.dump"
printf 'corruption' >> "$DUMP_FILE"
expect_fail "corrupted dump rejected" env DATABASE_URL="$SRC_URL" \
  "$SCRIPT_DIR/restore-db.sh" "$BK" --target "$RESTORE_DB" --force
cp "$TMP_ROOT/good.dump" "$DUMP_FILE"

say "4. Restoring over the live database is refused without --allow-live"
expect_fail "live target refused" env DATABASE_URL="$SRC_URL" \
  "$SCRIPT_DIR/restore-db.sh" "$BK" --target "$SRC_DB"

say "5. Simulated data loss, then recovery"
psql -c "DROP DATABASE \"$SRC_DB\";" >/dev/null
if psql -tAc "select 1 from pg_database where datname='$SRC_DB'" | grep -q 1; then
  bad "source database still present after simulated loss"
else
  ok "source database dropped (disaster simulated)"
fi
DATABASE_URL="$SRC_URL" "$SCRIPT_DIR/restore-db.sh" "$BK" --allow-live >/dev/null
RECOVERED="$(PGDATABASE="$SRC_DB" psql -tAc 'select count(*) from users')"
expect_eq 250 "$RECOVERED" "users recovered after loss"
RECOVERED_NAME="$(PGDATABASE="$SRC_DB" psql -tAc "select email from users where id=250")"
expect_eq 'user-250@wasit.tn' "$RECOVERED_NAME" "row contents recovered, not just shape"

say "6. Retention prunes old backups; a failed run leaves nothing behind"
for _ in 1 2 3; do
  DATABASE_URL="$SRC_URL" BACKUP_ROOT="$BACKUP_ROOT" BACKUP_RETENTION_COUNT=2 \
    "$SCRIPT_DIR/backup-db.sh" >/dev/null
  sleep 1
done
KEPT="$(ls -d "$BACKUP_ROOT"/*Z | wc -l | tr -d ' ')"
expect_eq 2 "$KEPT" "retention keeps only the newest 2"
DATABASE_URL="postgresql://wasit:definitely-wrong@localhost:5432/$SRC_DB" \
  BACKUP_ROOT="$FAIL_ROOT" "$SCRIPT_DIR/backup-db.sh" >/dev/null 2>&1 || true
LEFTOVER="$(ls -d "$FAIL_ROOT"/*Z 2>/dev/null | wc -l | tr -d ' ' || true)"
expect_eq 0 "$LEFTOVER" "failed backup left no folder"

printf '\n== Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
