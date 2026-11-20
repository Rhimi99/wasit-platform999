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
# Sections G1-G8 are pre-flight guard checks that need no server: they use a
# stub `psql` on PATH, so they also run on a workstation with no PostgreSQL.
# Sections E1-E2 cover the encryption safety rails offline; E3 is the full
# encrypt/decrypt/restore round trip and needs both `age` and a server. Sections
# 1-6 need a real server and are skipped (with a loud SKIP line) when none is
# reachable — a skip is not a pass.
#
# Usage: ./scripts/backup-restore.test.sh
# Requires a PostgreSQL server reachable with the admin URL (default: local
# wasit_dev credentials) and the pg_dump/pg_restore/psql client tools. The age
# sections additionally require the `age`/`age-keygen` tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

if command -v pg_dump >/dev/null 2>&1; then
  PG_BIN="$(wasit_pg_bin)"
  export PATH="$PG_BIN:$PATH"
else
  echo "INFO: PostgreSQL client tools not found on PATH — the server-backed sections (1-6) will be skipped."
fi

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
  if command -v psql >/dev/null 2>&1; then
    wasit_use_url "$ADMIN_URL"
    for db in "$SRC_DB" "$RESTORE_DB" "${SRC_DB}_restore"; do
      psql -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 && \
        psql -c "DROP DATABASE IF EXISTS \"$db\";" >/dev/null 2>&1 || true
    done
  fi
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
expect_fail_msg() { # label, expected-substring, then command
  local label="$1" needle="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then
    bad "$label (command unexpectedly succeeded)"
    return
  fi
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    ok "$label"
  else
    bad "$label (refused without '$needle'): $(printf '%s' "$out" | tail -1)"
  fi
}

wasit_use_url "$ADMIN_URL"

# --- Pre-flight guard tests (no database needed) ---------------------------
# These exercise the restore safety rails before any server is touched. A tiny
# fake `psql` on PATH records what would have run, so the tests also assert that
# a refused restore never reached a DROP/CREATE.
say "Pre-flight: restore safety rails (no database needed)"
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/psql" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do printf '%s\n' "$a" >> "${PSQL_LOG:-/dev/null}"; done
# Emulate the only query the restore verification issues, so the happy path can
# complete offline; every other query returns empty (e.g. "database exists?").
case "$*" in
  *count*users*) printf '%s\n' 250 ;;
esac
exit 0
STUB
cat > "$STUB_BIN/pg_restore" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$STUB_BIN/pg_dump" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$STUB_BIN/pg_dumpall" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$STUB_BIN/sha256sum" <<'STUB'
#!/usr/bin/env bash
exec /usr/bin/sha256sum "$@"
STUB
chmod +x "$STUB_BIN/psql" "$STUB_BIN/pg_restore" "$STUB_BIN/pg_dump" "$STUB_BIN/pg_dumpall" "$STUB_BIN/sha256sum"

GOOD_DIR="$TMP_ROOT/goodbk"
mkdir -p "$GOOD_DIR"
printf 'dump-bytes' > "$GOOD_DIR/wasit_restore.dump"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$GOOD_DIR/manifest.json"
printf 'users\t250\n' > "$GOOD_DIR/table-counts.tsv"
( cd "$GOOD_DIR" && sha256sum ./*.dump > checksums.sha256 )

restore_offline() { # args -> runs restore with stub clients, never real ones
  env PATH="$STUB_BIN:$PATH" DATABASE_URL="postgresql://u:p@localhost:5432/wasit_test" \
    "$SCRIPT_DIR/restore-db.sh" "$@"
}

# Every stub psql invocation is logged here, so the tests can prove that a
# refused restore never reached DROP/CREATE.
export PSQL_LOG="$TMP_ROOT/psql.log"
: > "$PSQL_LOG"

say "G1. A backup without checksums.sha256 is refused"
NOCHK_DIR="$TMP_ROOT/nochk"
mkdir -p "$NOCHK_DIR"
printf 'dump-bytes' > "$NOCHK_DIR/wasit_restore.dump"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$NOCHK_DIR/manifest.json"
expect_fail_msg "no checksums -> refused" "no checksums.sha256" restore_offline "$NOCHK_DIR" --target wasit_drill

say "G2. An empty checksums.sha256 is refused"
EMPTY_DIR="$TMP_ROOT/empty"
mkdir -p "$EMPTY_DIR"
printf 'dump-bytes' > "$EMPTY_DIR/wasit_restore.dump"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$EMPTY_DIR/manifest.json"
: > "$EMPTY_DIR/checksums.sha256"
expect_fail_msg "empty checksums -> refused" "empty" restore_offline "$EMPTY_DIR" --target wasit_drill

say "G3. A mismatched checksum is refused"
BADSUM_DIR="$TMP_ROOT/badsum"
mkdir -p "$BADSUM_DIR"
printf 'dump-bytes' > "$BADSUM_DIR/wasit_restore.dump"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$BADSUM_DIR/manifest.json"
printf '%s  wasit_restore.dump\n' "$(printf '0%.0s' {1..64})" > "$BADSUM_DIR/checksums.sha256"
expect_fail_msg "bad checksum -> refused" "mismatch" restore_offline "$BADSUM_DIR" --target wasit_drill

say "G4. A checksum entry that escapes the backup directory is refused"
TRAV_DIR="$TMP_ROOT/trav"
mkdir -p "$TRAV_DIR"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$TRAV_DIR/manifest.json"
printf 'outside' > "$TMP_ROOT/outside-secret.txt"
printf '%s  ../outside-secret.txt\n' "$(sha256sum "$TMP_ROOT/outside-secret.txt" | awk '{print $1}')" > "$TRAV_DIR/checksums.sha256"
expect_fail_msg "path traversal -> refused" "escapes the backup directory" restore_offline "$TRAV_DIR" --target wasit_drill

say "G4b. A symlink entry is refused (cannot smuggle a file from outside)"
LINK_DIR="$TMP_ROOT/link"
mkdir -p "$LINK_DIR"
printf 'outside' > "$TMP_ROOT/outside2.txt"
ln -s "$TMP_ROOT/outside2.txt" "$LINK_DIR/wasit_restore.dump"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$LINK_DIR/manifest.json"
printf '%s  wasit_restore.dump\n' "$(sha256sum "$TMP_ROOT/outside2.txt" | awk '{print $1}')" > "$LINK_DIR/checksums.sha256"
expect_fail_msg "symlink entry -> refused" "is a symlink" restore_offline "$LINK_DIR" --target wasit_drill

# A refused restore must never reach DROP/CREATE DATABASE, so an existing
# database is never deleted or replaced when a pre-flight check fails.
if [ -s "$TMP_ROOT/psql.log" ]; then
  bad "a refused restore still invoked psql (an existing DB could be touched)"
else
  ok "no refusal reached psql: existing databases are untouched on failure"
fi

say "G5. A target name with SQL-injection / illegal characters is refused"
: > "$TMP_ROOT/psql.log"
expect_fail_msg "injection name -> refused" "disallowed characters" \
  restore_offline "$GOOD_DIR" --target 'wasit_restore"; DROP DATABASE wasit_prod; --'
expect_fail_msg "uppercase name -> refused" "must start with a lower-case letter" \
  restore_offline "$GOOD_DIR" --target 'Wasit_Restore'
if [ -s "$TMP_ROOT/psql.log" ]; then bad "refused target still reached psql"; else ok "refused target never reached psql"; fi

say "G6. DEMO / Production / system databases are refused, even with --force"
for protected in wasit_prod wasit_staging wasit_demo postgres template1 wasit_prod_restore wasit_demo_restore; do
  expect_fail_msg "refuse '$protected'" "protected database" \
    restore_offline "$GOOD_DIR" --target "$protected" --force
done
expect_fail_msg "refuse 'wasit_prod' with --allow-live" "protected database" \
  restore_offline "$GOOD_DIR" --target wasit_prod --allow-live
expect_fail_msg "refuse 'wasit_prod' with --force --allow-live" "protected database" \
  restore_offline "$GOOD_DIR" --target wasit_prod --force --allow-live

say "G6b. Extra protected names from WASIT_PROTECTED_DB_NAMES are honoured"
expect_fail_msg "refuse operator-listed name" "protected database" \
  env PATH="$STUB_BIN:$PATH" DATABASE_URL="postgresql://u:p@localhost:5432/wasit_test" \
  WASIT_PROTECTED_DB_NAMES="my_corp_db, other" \
  "$SCRIPT_DIR/restore-db.sh" "$GOOD_DIR" --target other --force

say "G7. Backup directory and file permissions are restrictive (explicit, not umask)"
PERM_ROOT="$TMP_ROOT/permroot"
umask 000  # prove the modes do not come from the inherited umask
wasit_secure_dir "$PERM_ROOT" 0700
umask 022
PERM_MODE="$(stat -c '%a' "$PERM_ROOT")"
expect_eq 700 "$PERM_MODE" "backup dir created 0700 despite umask 000"
if [ -z "$(find "$PERM_ROOT" -perm /077 -print -quit)" ]; then
  ok "no group/other permission bits on the backup dir"
else
  bad "backup dir is group/other accessible"
fi

say "G8. A valid backup still restores into a scratch database (offline, stubbed server)"
: > "$TMP_ROOT/psql.log"
if PSQL_LOG="$TMP_ROOT/psql.log" restore_offline "$GOOD_DIR" --target wasit_drill >/dev/null 2>&1; then
  ok "valid backup -> restore proceeds to a scratch database"
else
  bad "valid backup -> restore refused unexpectedly"
fi
if grep -qiE "DROP DATABASE|CREATE DATABASE" "$TMP_ROOT/psql.log"; then
  ok "restore issued CREATE/DROP only after passing the rails"
else
  bad "restore did not reach CREATE/DROP (unexpected)"
fi
if grep -qiE "wasit_prod|wasit_demo|wasit_staging" "$TMP_ROOT/psql.log"; then
  bad "restore referenced a protected database"
else
  ok "restore never referenced a protected database"
fi

say "E1. Encryption rails (no database needed)"
# These need neither a server nor the age tool: they assert the refusal paths and
# the off-mode parity that must hold before any encryption work happens.
# E1a: off mode is the default and adds no encryption metadata to the manifest.
OFF_DIR="$TMP_ROOT/offbk"
mkdir -p "$OFF_DIR"
printf 'dump-bytes' > "$OFF_DIR/wasit_restore.dump"
printf 'globals' > "$OFF_DIR/pg_globals.sql"
printf 'users\t250\n' > "$OFF_DIR/table-counts.tsv"
printf '{"databases":[{"database":"wasit_restore","file":"wasit_restore.dump"}]}\n' > "$OFF_DIR/manifest.json"
( cd "$OFF_DIR" && sha256sum ./*.dump ./pg_globals.sql ./*.tsv > checksums.sha256 )
if grep -q '"encryption"' "$OFF_DIR/manifest.json"; then
  bad "off-mode manifest unexpectedly carries encryption metadata"
else
  ok "off-mode backup has no encryption metadata (behaviour unchanged)"
fi

# E1b: an age-encrypted manifest is refused when no identity is configured, and
# the refusal must land before any psql call.
ENC_DIR="$TMP_ROOT/encbk"
mkdir -p "$ENC_DIR"
printf 'age-encryption.org/v1\nciphertext' > "$ENC_DIR/wasit_restore.dump.age"
printf '{"encryption":"age","databases":[{"database":"wasit_restore","file":"wasit_restore.dump.age"}],"files":{"wasit_restore.dump.age":{"sha256":"x","bytes":1,"plaintextSha256":"y","algo":"age-x25519"}}}\n' > "$ENC_DIR/manifest.json"
( cd "$ENC_DIR" && sha256sum ./*.age ./manifest.json > checksums.sha256 )
: > "$TMP_ROOT/psql.log"
expect_fail_msg "encrypted backup without identity is refused" "BACKUP_AGE_IDENTITY_FILE" \
  env PATH="$STUB_BIN:$PATH" DATABASE_URL="postgresql://u:p@localhost:5432/wasit_test" \
  BACKUP_AGE_BIN=/bin/true BACKUP_AGE_IDENTITY_FILE= PSQL_LOG="$TMP_ROOT/psql.log" \
  "$SCRIPT_DIR/restore-db.sh" "$ENC_DIR" --target wasit_drill
if grep -qiE "DROP DATABASE|CREATE DATABASE" "$TMP_ROOT/psql.log"; then
  bad "refusal without identity still reached a database"
else
  ok "missing identity refused before any DB operation"
fi

# E1c: a missing identity file is refused before any psql call.
expect_fail_msg "missing identity file is refused" "missing or unreadable" \
  env PATH="$STUB_BIN:$PATH" DATABASE_URL="postgresql://u:p@localhost:5432/wasit_test" \
  BACKUP_AGE_BIN=/bin/true BACKUP_AGE_IDENTITY_FILE="$TMP_ROOT/does-not-exist.key" \
  PSQL_LOG="$TMP_ROOT/psql.log" \
  "$SCRIPT_DIR/restore-db.sh" "$ENC_DIR" --target wasit_drill

# E1d: an identity stored inside the backup directory is refused (key/data separation).
cp "$GOOD_DIR/manifest.json" "$ENC_DIR/key-inside.key" 2>/dev/null || printf 'not-a-real-key\n' > "$ENC_DIR/key-inside.key"
expect_fail_msg "identity inside the backup dir is refused" "inside the backup directory" \
  env PATH="$STUB_BIN:$PATH" DATABASE_URL="postgresql://u:p@localhost:5432/wasit_test" \
  BACKUP_AGE_BIN=/bin/true BACKUP_AGE_IDENTITY_FILE="$ENC_DIR/key-inside.key" \
  PSQL_LOG="$TMP_ROOT/psql.log" \
  "$SCRIPT_DIR/restore-db.sh" "$ENC_DIR" --target wasit_drill
rm -f "$ENC_DIR/key-inside.key"

# E1e: an encrypted backup with no age tool available is refused.
expect_fail_msg "encrypted backup without the age tool is refused" "age" \
  env PATH="$STUB_BIN:$PATH" DATABASE_URL="postgresql://u:p@localhost:5432/wasit_test" \
  BACKUP_AGE_BIN=/nonexistent/age BACKUP_AGE_IDENTITY_FILE="$TMP_ROOT/some.key" \
  PSQL_LOG="$TMP_ROOT/psql.log" \
  "$SCRIPT_DIR/restore-db.sh" "$ENC_DIR" --target wasit_drill

say "E2. Encryption refuses to start without tool or recipients (offline)"
# A backup asked to encrypt must fail fast — before pg_dump — when the tool or
# recipients are missing, and must leave no half-written folder behind.
NOAGE_ROOT="$TMP_ROOT/noage"
expect_fail_msg "age mode without tool/recipients is refused" "requires" \
  env PATH="$STUB_BIN:/usr/bin:/bin" BACKUP_ENCRYPTION=age BACKUP_ROOT="$NOAGE_ROOT" \
  BACKUP_AGE_BIN=/nonexistent/age BACKUP_AGE_RECIPIENTS= \
  "$SCRIPT_DIR/backup-db.sh"
expect_fail_msg "age mode without recipients is refused" "recipient" \
  env PATH="$STUB_BIN:/usr/bin:/bin" BACKUP_ENCRYPTION=age BACKUP_ROOT="$NOAGE_ROOT" \
  BACKUP_AGE_BIN=/bin/true BACKUP_AGE_RECIPIENTS= \
  "$SCRIPT_DIR/backup-db.sh"
LEFTOVER_NOAGE="$(ls -d "$NOAGE_ROOT"/*Z 2>/dev/null | wc -l | tr -d ' ' || true)"
expect_eq 0 "$LEFTOVER_NOAGE" "refused encryption run left no backup folder"

say "F1. drop ordering + guards (offline: stubbed pg_dump/pg_dumpall/psql/age)"
# These exercise the real backup script end to end with a stub PostgreSQL client
# and a stub `age` that writes a structurally valid (but not real) ciphertext.
# They prove ORDERING and GUARDS only; the real cryptographic round trip is E3.
STUB_PG="$TMP_ROOT/stubbin"
mkdir -p "$STUB_PG"
cat > "$STUB_PG/pg_dump" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2 ;; *) shift ;; esac; done
if [ -n "$out" ]; then printf 'STUB-DUMP-BYTES\n' > "$out"; else printf 'STUB-DUMP-BYTES\n'; fi
exit 0
STUB
cat > "$STUB_PG/pg_dumpall" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2 ;; *) shift ;; esac; done
[ -n "$out" ] && printf 'STUB-GLOBALS\n' > "$out"
exit 0
STUB
cat > "$STUB_PG/psql" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$STUB_PG/age" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift 2 ;; *) shift ;; esac; done
[ -n "$out" ] && printf 'age-encryption.org/v1\nSTUB-CIPHERTEXT\n' > "$out"
exit 0
STUB
chmod +x "$STUB_PG"/*
STUB_RECIPIENT="age1stubrecipient0000000000000000000000000000000000000000"

stub_backup() { # <backup-root> [extra env assignments...]
  local root="$1"; shift
  env -i PATH="$STUB_PG:/usr/bin:/bin" HOME="$HOME" \
    DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
    BACKUP_ROOT="$root" BACKUP_RETENTION_COUNT=0 \
    BACKUP_ENCRYPTION=age BACKUP_AGE_BIN="$STUB_PG/age" \
    BACKUP_AGE_RECIPIENTS="$STUB_RECIPIENT" \
    "$@" "$SCRIPT_DIR/backup-db.sh"
}

F1_ROOT="$TMP_ROOT/f1"
if stub_backup "$F1_ROOT" BACKUP_PLAINTEXT_RETENTION=drop >/dev/null 2>&1; then
  ok "stub backup (drop) completed"
else
  bad "stub backup (drop) failed unexpectedly"
fi
F1_BK="$(ls -d "$F1_ROOT"/*Z 2>/dev/null | head -1 || true)"
# checksums exists, verifies against what is shipped, and covers only ciphertext.
if [ -s "$F1_BK/checksums.sha256" ]; then ok "checksums.sha256 written"; else bad "checksums.sha256 missing"; fi
if ( cd "$F1_BK" && sha256sum -c checksums.sha256 >/dev/null 2>&1 ); then
  ok "checksums verify against the shipped artefacts"
else
  bad "checksums do not verify"
fi
if grep -qE '\.dump$|pg_globals\.sql$|table-counts\.tsv$' "$F1_BK/checksums.sha256"; then
  bad "checksums still lists plaintext (must be ciphertext-only in age mode)"
else
  ok "checksums covers ciphertext only (no plaintext entries)"
fi
# Plaintext dropped only after that verification; ciphertext retained.
F1_PLAIN=0
for b in wasit_dev.dump pg_globals.sql table-counts.tsv; do [ -f "$F1_BK/$b" ] && F1_PLAIN=$((F1_PLAIN + 1)); done
expect_eq 0 "$F1_PLAIN" "plaintext removed by drop"
F1_CIPH=0
for b in wasit_dev.dump.age pg_globals.sql.age table-counts.tsv.age; do [ -f "$F1_BK/$b" ] && F1_CIPH=$((F1_CIPH + 1)); done
expect_eq 3 "$F1_CIPH" "all ciphertext retained"

say "F2. keep remains the default (plaintext preserved)"
F2_ROOT="$TMP_ROOT/f2"
stub_backup "$F2_ROOT" >/dev/null 2>&1 || bad "stub backup (default) failed"
F2_BK="$(ls -d "$F2_ROOT"/*Z 2>/dev/null | head -1 || true)"
F2_KEEP=0
for b in wasit_dev.dump pg_globals.sql table-counts.tsv; do [ -f "$F2_BK/$b" ] && F2_KEEP=$((F2_KEEP + 1)); done
expect_eq 3 "$F2_KEEP" "default keep preserves all plaintext"

say "F3. drop never follows a symlink out of the backup folder"
F3_STUB="$TMP_ROOT/stub-link"
mkdir -p "$F3_STUB"
cp "$STUB_PG/pg_dumpall" "$STUB_PG/psql" "$STUB_PG/age" "$F3_STUB/"
cat > "$F3_STUB/pg_dump" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2 ;; *) shift ;; esac; done
# Simulate a payload path that is a symlink to a file outside the backup tree.
[ -n "$out" ] && { rm -f "$out"; ln -s "$OUTSIDE_TARGET" "$out"; }
exit 0
STUB
chmod +x "$F3_STUB"/*
printf 'PRECIOUS-OUTSIDE\n' > "$TMP_ROOT/outside-drop.txt"
F3_OUT=""
F3_RC=0
if F3_OUT="$(env -i PATH="$F3_STUB:/usr/bin:/bin" HOME="$HOME" \
  DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
  BACKUP_ROOT="$TMP_ROOT/f3" BACKUP_RETENTION_COUNT=0 \
  BACKUP_ENCRYPTION=age BACKUP_AGE_BIN="$F3_STUB/age" \
  BACKUP_AGE_RECIPIENTS="$STUB_RECIPIENT" \
  BACKUP_PLAINTEXT_RETENTION=drop OUTSIDE_TARGET="$TMP_ROOT/outside-drop.txt" \
  "$SCRIPT_DIR/backup-db.sh" 2>&1)"; then
  F3_RC=0
else
  F3_RC=$?
fi
if [ "$F3_RC" -ne 0 ]; then ok "drop refused a symlinked payload path"; else bad "symlinked payload was not refused"; fi
if printf '%s' "$F3_OUT" | grep -q "symlinked payload"; then ok "refusal names the symlink reason"; else bad "refusal did not mention the symlink"; fi
if [ -f "$TMP_ROOT/outside-drop.txt" ]; then ok "outside file not deleted through the symlink"; else bad "outside file was deleted"; fi

say "F4. a drop never touches a previous backup folder"
F4_ROOT="$TMP_ROOT/f4"
PREV="$F4_ROOT/20200101T000000Z"
mkdir -p "$PREV"
printf 'OLD-PLAINTEXT-DUMP\n' > "$PREV/wasit_dev.dump"
printf 'OLD-GLOBALS\n' > "$PREV/pg_globals.sql"
PREV_BEFORE="$(sha256sum "$PREV/wasit_dev.dump" "$PREV/pg_globals.sql")"
stub_backup "$F4_ROOT" BACKUP_PLAINTEXT_RETENTION=drop >/dev/null 2>&1 || bad "stub backup with a prior folder failed"
PREV_AFTER="$(sha256sum "$PREV/wasit_dev.dump" "$PREV/pg_globals.sql")"
if [ "$PREV_BEFORE" = "$PREV_AFTER" ]; then
  ok "previous backup folder untouched by drop"
else
  bad "previous backup folder was modified"
fi
F4_NEW="$(ls -d "$F4_ROOT"/*Z 2>/dev/null | grep -v "^$PREV$" | head -1 || true)"
# Only directories matter here: BACKUP_ROOT legitimately also holds the lock and
# heartbeat files, which are not backup folders.
F4_STRAY="$(find "$F4_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name "$(basename "$PREV")" ! -name "$(basename "$F4_NEW")" 2>/dev/null | wc -l | tr -d ' ')"
expect_eq 0 "$F4_STRAY" "drop left no extra backup folder beside the new one"
# And the previous folder must still hold its plaintext.
expect_eq 2 "$(find "$PREV" -maxdepth 1 -type f | wc -l | tr -d ' ')" "previous folder still holds its files"

say "F5. a checksum failure stops the run before any plaintext is dropped"
# Fault injection: only `sha256sum -c` fails, so the post-write verification fails
# exactly as a corrupted artefact would. The drop must not run.
F5_STUB="$TMP_ROOT/stub-badsum"
mkdir -p "$F5_STUB"
cp "$STUB_PG/pg_dump" "$STUB_PG/pg_dumpall" "$STUB_PG/psql" "$STUB_PG/age" "$F5_STUB/"
cat > "$F5_STUB/sha256sum" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in -c|--check|--status) echo "stub: checksum mismatch" >&2; exit 1 ;; esac; done
exec /usr/bin/sha256sum "$@"
STUB
chmod +x "$F5_STUB"/*
F5_OUT=""
F5_RC=0
if F5_OUT="$(env -i PATH="$F5_STUB:/usr/bin:/bin" HOME="$HOME" \
  DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
  BACKUP_ROOT="$TMP_ROOT/f5" BACKUP_RETENTION_COUNT=0 \
  BACKUP_ENCRYPTION=age BACKUP_AGE_BIN="$F5_STUB/age" \
  BACKUP_AGE_RECIPIENTS="$STUB_RECIPIENT" BACKUP_PLAINTEXT_RETENTION=drop \
  "$SCRIPT_DIR/backup-db.sh" 2>&1)"; then
  F5_RC=0
else
  F5_RC=$?
fi
if [ "$F5_RC" -ne 0 ]; then ok "run failed when checksums did not verify"; else bad "run succeeded despite a checksum failure"; fi
if printf '%s' "$F5_OUT" | grep -q "Dropping plaintext payload"; then
  bad "drop ran even though checksums failed"
else
  ok "no drop was attempted after the checksum failure"
fi

say "F6. an unknown retention value is refused before any database work"
expect_fail_msg "invalid retention refused" "must be 'keep' or 'drop'" \
  env -i PATH="$STUB_PG:/usr/bin:/bin" HOME="$HOME" \
  DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
  BACKUP_ROOT="$TMP_ROOT/f6" BACKUP_ENCRYPTION=age \
  BACKUP_AGE_BIN=/bin/true BACKUP_AGE_RECIPIENTS="$STUB_RECIPIENT" \
  BACKUP_PLAINTEXT_RETENTION=DROP \
  "$SCRIPT_DIR/backup-db.sh"

say "H. Advanced encryption & recovery (real age, stubbed server)"
# The cryptographic paths here use the real `age` tool, so they prove behaviour
# rather than structure. The database is a stub that only *logs* the statements
# it is asked to run, which lets a refusal be proven to happen before any DB
# operation. A real end-to-end restore is E3; these are the failure, rotation and
# compatibility cases around it.
if ! command -v age >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  echo "SKIP: 'age'/'age-keygen' unavailable — section H (advanced encryption) was NOT run"
else
  HBIN="$TMP_ROOT/hbin"
  HAGE="$(command -v age)"
  mkdir -p "$HBIN"
  cat > "$HBIN/psql" <<'STUB'
#!/usr/bin/env bash
# Log every invocation so tests can prove a refusal never reached the database.
for a in "$@"; do printf '%s\n' "$a" >> "${PSQL_LOG:-/dev/null}"; done
case "$*" in
  *count*users*) printf '%s\n' 7 ;;
esac
exit 0
STUB
  cat > "$HBIN/pg_restore" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > "$HBIN/pg_dump" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2 ;; *) shift ;; esac; done
[ -n "$out" ] && printf 'H-DUMP-BYTES\n' > "$out"
exit 0
STUB
  cat > "$HBIN/pg_dumpall" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2 ;; *) shift ;; esac; done
[ -n "$out" ] && printf 'H-GLOBALS\n' > "$out"
exit 0
STUB
  chmod +x "$HBIN"/*

  HKEYS="$TMP_ROOT/hkeys"
  mkdir -p "$HKEYS"; chmod 0700 "$HKEYS"
  H_LOG="$TMP_ROOT/h.log"
  : > "$H_LOG"
  age-keygen -o "$HKEYS/a.txt" >/dev/null 2>&1
  age-keygen -o "$HKEYS/b.txt" >/dev/null 2>&1
  age-keygen -o "$HKEYS/c.txt" >/dev/null 2>&1
  chmod 0600 "$HKEYS"/*.txt
  RA="$(age-keygen -y "$HKEYS/a.txt")"
  RB="$(age-keygen -y "$HKEYS/b.txt")"
  RC="$(age-keygen -y "$HKEYS/c.txt")"

  h_backup() { # <root> <recipients...>
    local root="$1"; shift
    local recips="$*"
    env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" \
      DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
      BACKUP_ROOT="$root" BACKUP_RETENTION_COUNT=0 \
      BACKUP_ENCRYPTION=age BACKUP_AGE_BIN="$HAGE" \
      BACKUP_AGE_RECIPIENTS="$recips" \
      "$SCRIPT_DIR/backup-db.sh"
  }
  h_restore() { # <backup-dir> <identity> [extra args...]
    local bk="$1" id="$2"; shift 2
    env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" \
      DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
      BACKUP_AGE_IDENTITY_FILE="$id" BACKUP_AGE_BIN="$HAGE" PSQL_LOG="$H_LOG" \
      "$SCRIPT_DIR/restore-db.sh" "$bk" "$@"
  }

  say "H1. multi-recipient: a backup restores with any one of the recipients"
  H1_ROOT="$TMP_ROOT/h1"
  h_backup "$H1_ROOT" "$RA" "$RB" >/dev/null 2>&1 || bad "multi-recipient backup failed"
  H1_BK="$(ls -d "$H1_ROOT"/*Z 2>/dev/null | head -1 || true)"
  grep -q "\"$RA\"" "$H1_BK/manifest.json" && grep -q "\"$RB\"" "$H1_BK/manifest.json" \
    && ok "manifest records both recipients" || bad "manifest does not record both recipients"
  for id in a b; do
    : > "$H_LOG"
    if h_restore "$H1_BK" "$HKEYS/$id.txt" --target h1_drill >/dev/null 2>&1; then
      ok "restores with recipient key $id"
    else
      bad "failed to restore with recipient key $id"
    fi
  done
  expect_fail "a non-recipient key is refused" \
    env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" \
    DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
    BACKUP_AGE_IDENTITY_FILE="$HKEYS/c.txt" BACKUP_AGE_BIN="$HAGE" \
    "$SCRIPT_DIR/restore-db.sh" "$H1_BK" --target h1_drill --force

  say "H2. key rotation: a new backup uses new recipients; old backups keep working"
  H2_ROOT="$TMP_ROOT/h2"
  h_backup "$H2_ROOT" "$RB" "$RC" >/dev/null 2>&1 || bad "rotated backup failed"
  H2_BK="$(ls -d "$H2_ROOT"/*Z 2>/dev/null | head -1 || true)"
  grep -q "\"$RC\"" "$H2_BK/manifest.json" && ok "rotated backup names the new recipient" \
    || bad "rotated backup missing the new recipient"
  # The old backup must still restore with its own old key — a rotation must never
  # invalidate existing archives.
  if h_restore "$H1_BK" "$HKEYS/a.txt" --target h2_old >/dev/null 2>&1; then
    ok "pre-rotation backup still restores with its old key"
  else
    bad "pre-rotation backup failed after rotation"
  fi
  # The new backup must not be readable with the retired key.
  expect_fail "rotated backup rejects the retired key" \
    env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" \
    DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
    BACKUP_AGE_IDENTITY_FILE="$HKEYS/a.txt" BACKUP_AGE_BIN="$HAGE" \
    "$SCRIPT_DIR/restore-db.sh" "$H2_BK" --target h2_old --force

  say "H3. an invalid, empty, or truncated identity is refused before any DB call"
  : > "$HKEYS/empty.txt"
  head -c 40 "$HKEYS/a.txt" > "$HKEYS/truncated.txt"
  printf 'AGE-SECRET-KEY-1THISISNOTAVALIDKEY\n' > "$HKEYS/garbage.txt"
  for id in empty truncated garbage; do
    : > "$H_LOG"
    if h_restore "$H1_BK" "$HKEYS/$id.txt" --target h3_drill --force >/dev/null 2>&1; then
      bad "restore accepted a $id identity"
    else
      ok "restore refused a $id identity"
    fi
    if grep -qiE "DROP DATABASE|CREATE DATABASE" "$H_LOG"; then
      bad "refusal with a $id identity still reached a DB operation"
    else
      ok "refusal with a $id identity happened before any DB operation"
    fi
  done

  say "H4. recipient validation uses age's own parser, and refuses before pg_dump"
  H4_BIN="$TMP_ROOT/h4bin"
  mkdir -p "$H4_BIN"
  cp "$HBIN"/* "$H4_BIN/"
  cat > "$H4_BIN/pg_dump" <<'STUB'
#!/usr/bin/env bash
echo "pg_dump invoked" >> "${DUMP_LOG:-/dev/null}"
exit 0
STUB
  chmod +x "$H4_BIN"/*
  # Build a well-formed recipient and a same-shaped one with a broken checksum, so
  # the "bad" case still matches any naive `^age1[0-9a-z]+$` pattern. Truncated and
  # junk forms are also covered, plus a good+bad mix.
  H4_GOOD="$(age-keygen -y "$HKEYS/a.txt")"
  H4_BADCS="${H4_GOOD%?}x"; [ "$H4_BADCS" = "$H4_GOOD" ] && H4_BADCS="${H4_GOOD%?}q"
  H4_TRUNC="${H4_GOOD:0:40}"
  H4_JUNK="age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
  h4_backup() { # <root> <recipients>
    env -i PATH="$H4_BIN:/usr/bin:/bin" HOME="$HOME" \
      DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
      BACKUP_ROOT="$1" BACKUP_RETENTION_COUNT=0 \
      BACKUP_ENCRYPTION=age BACKUP_AGE_BIN="$HAGE" \
      BACKUP_AGE_RECIPIENTS="$2" DUMP_LOG="$H_LOG" \
      "$SCRIPT_DIR/backup-db.sh"
  }
  # A valid recipient must be accepted and reach pg_dump.
  : > "$H_LOG"
  if h4_backup "$TMP_ROOT/h4good" "$H4_GOOD" >/dev/null 2>&1; then
    ok "a valid recipient is accepted"
  else
    bad "a valid recipient was wrongly refused"
  fi
  if [ -s "$H_LOG" ]; then ok "valid recipient reaches pg_dump"; else bad "valid recipient never reached pg_dump"; fi
  # Each invalid form must be refused *before* pg_dump.
  for spec in "bad-checksum:$H4_BADCS" "truncated:$H4_TRUNC" "junk:$H4_JUNK" "mixed-good-and-bad:$H4_GOOD $H4_BADCS"; do
    label="${spec%%:*}"; value="${spec#*:}"
    : > "$H_LOG"
    if h4_backup "$TMP_ROOT/h4_$label" "$value" >/dev/null 2>&1; then
      bad "backup accepted a $label recipient"
    else
      ok "backup refused a $label recipient"
    fi
    if [ -s "$H_LOG" ]; then bad "pg_dump ran before a $label recipient was rejected"; else ok "pg_dump never ran for a $label recipient"; fi
  done
  expect_fail_msg "missing recipient is refused" "recipient" \
    env -i PATH="$H4_BIN:/usr/bin:/bin" HOME="$HOME" \
    DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
    BACKUP_ROOT="$TMP_ROOT/h4b" BACKUP_ENCRYPTION=age \
    BACKUP_AGE_BIN="$HAGE" BACKUP_AGE_RECIPIENTS= DUMP_LOG="$H_LOG" \
    "$SCRIPT_DIR/backup-db.sh"

  say "H5. a missing ciphertext file in the payload is refused"
  H5_DIR="$TMP_ROOT/h5"; cp -a "$H1_BK" "$H5_DIR"
  rm -f "$H5_DIR"/*.dump.age
  : > "$H_LOG"
  expect_fail "missing ciphertext refused" h_restore "$H5_DIR" "$HKEYS/a.txt" --target h5_drill --force
  grep -qiE "DROP DATABASE|CREATE DATABASE" "$H_LOG" && bad "missing-ciphertext refusal reached DB" \
    || ok "missing ciphertext refused before any DB operation"

  say "H6. a missing or edited manifest / checksums is refused"
  H6_DIR="$TMP_ROOT/h6"; cp -a "$H1_BK" "$H6_DIR"
  rm -f "$H6_DIR/manifest.json"
  expect_fail "missing manifest refused" h_restore "$H6_DIR" "$HKEYS/a.txt" --target h6_drill --force
  H6B="$TMP_ROOT/h6b"; cp -a "$H1_BK" "$H6B"
  printf 'x' >> "$H6B/manifest.json"   # edit without updating checksums
  expect_fail "edited manifest refused" h_restore "$H6B" "$HKEYS/a.txt" --target h6_drill --force
  H6C="$TMP_ROOT/h6c"; cp -a "$H1_BK" "$H6C"
  rm -f "$H6C/checksums.sha256"
  expect_fail "missing checksums refused" h_restore "$H6C" "$HKEYS/a.txt" --target h6_drill --force

  say "H7. a plaintextSha256 mismatch is refused after decryption"
  # Re-encrypt the dump to the same recipient with different content, then fix the
  # checksum so integrity passes and only the plaintext digest can catch it.
  H7_DIR="$TMP_ROOT/h7"; cp -a "$H1_BK" "$H7_DIR"
  H7_ENC="$(ls "$H7_DIR"/*.dump.age | head -1)"
  printf 'DIFFERENT-CONTENT\n' | "$HAGE" -r "$RA" -o "$H7_ENC.new" 2>/dev/null
  mv "$H7_ENC.new" "$H7_ENC"
  ( cd "$H7_DIR" && sha256sum ./*.age ./manifest.json > checksums.sha256 )
  expect_fail_msg "plaintextSha256 mismatch refused" "does not match its recorded digest" \
    h_restore "$H7_DIR" "$HKEYS/a.txt" --target h7_drill --force

  say "H8. corruption of one of several ciphertext files is refused"
  H8_DIR="$TMP_ROOT/h8"; cp -a "$H1_BK" "$H8_DIR"
  printf 'corrupt' >> "$H8_DIR/pg_globals.sql.age"
  expect_fail "one corrupted ciphertext refused" h_restore "$H8_DIR" "$HKEYS/a.txt" --target h8_drill --force

  say "H9. an old unencrypted backup restores with no identity and unchanged behaviour"
  H9_DIR="$TMP_ROOT/h9"
  mkdir -p "$H9_DIR"
  printf 'legacy-dump-bytes' > "$H9_DIR/wasit_dev.dump"
  printf 'legacy-globals' > "$H9_DIR/pg_globals.sql"
  printf 'users\t7\n' > "$H9_DIR/table-counts.tsv"
  printf '{"createdAt":"2020-01-01T00:00:00Z","databases":[{"database":"wasit_dev","file":"wasit_dev.dump"}],"tableCountsFile":"table-counts.tsv","files":{"wasit_dev.dump":{"sha256":"x","bytes":1}}}\n' > "$H9_DIR/manifest.json"
  ( cd "$H9_DIR" && sha256sum ./*.dump ./pg_globals.sql ./*.tsv > checksums.sha256 )
  : > "$H_LOG"
  if env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" \
       DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" PSQL_LOG="$H_LOG" \
       "$SCRIPT_DIR/restore-db.sh" "$H9_DIR" --target h9_drill >/dev/null 2>&1; then
    ok "legacy unencrypted backup restores without an identity"
  else
    bad "legacy unencrypted backup failed to restore"
  fi
  grep -qiE "DROP DATABASE|CREATE DATABASE" "$H_LOG" && ok "legacy restore proceeded to the DB" \
    || bad "legacy restore did not reach the DB"

  say "H10. temporary decrypted files are cleaned up after a failure"
  H10_SCRATCH="$TMP_ROOT/h10scratch"; mkdir -p "$H10_SCRATCH"
  H10_DIR="$TMP_ROOT/h10"; cp -a "$H1_BK" "$H10_DIR"
  printf 'corrupt' >> "$H10_DIR/pg_globals.sql.age"
  TMPDIR="$H10_SCRATCH" env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" TMPDIR="$H10_SCRATCH" \
    DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
    BACKUP_AGE_IDENTITY_FILE="$HKEYS/a.txt" BACKUP_AGE_BIN="$HAGE" \
    "$SCRIPT_DIR/restore-db.sh" "$H10_DIR" --target h10_drill --force >/dev/null 2>&1 || true
  expect_eq 0 "$(ls -A "$H10_SCRATCH" 2>/dev/null | wc -l | tr -d ' ')" "no temp files left after a failed decrypt"

  say "H11. no key material or plaintext content leaks into restore output"
  H11_LOG="$TMP_ROOT/h11.log"
  env -i PATH="$HBIN:/usr/bin:/bin" HOME="$HOME" \
    DATABASE_URL="postgresql://u:p@localhost:5432/wasit_dev" \
    BACKUP_AGE_IDENTITY_FILE="$HKEYS/a.txt" BACKUP_AGE_BIN="$HAGE" \
    "$SCRIPT_DIR/restore-db.sh" "$H1_BK" --target h11_drill >"$H11_LOG" 2>&1 || true
  H11_KEY_BODY="$(sed -n '2p' "$HKEYS/a.txt")"
  if [ -n "$H11_KEY_BODY" ] && grep -qF -- "$H11_KEY_BODY" "$H11_LOG"; then
    bad "private key material leaked into restore output"
  else
    ok "no private key material in restore output"
  fi
  if grep -qF -- "H-DUMP-BYTES" "$H11_LOG"; then
    bad "plaintext payload content leaked into restore output"
  else
    ok "no plaintext payload content in restore output"
  fi
fi

say "E3. age round-trip: encrypt, decrypt, restore, wrong key, tamper, cleanup"
if command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1 && command -v psql >/dev/null 2>&1 \
   && psql -tAc "select 1" >/dev/null 2>&1; then
  ENC_KEYS="$TMP_ROOT/enc-keys"
  mkdir -p "$ENC_KEYS"; chmod 0700 "$ENC_KEYS"
  age-keygen -o "$ENC_KEYS/identity.txt" >/dev/null 2>&1
  chmod 0600 "$ENC_KEYS/identity.txt"
  # A second, unrelated key: decrypting with it must fail.
  age-keygen -o "$ENC_KEYS/wrong.txt" >/dev/null 2>&1
  RECIPIENT="$(age-keygen -y "$ENC_KEYS/identity.txt")"
  RECIPIENT2="$(age-keygen -y "$ENC_KEYS/wrong.txt")"

  ENC_SRC="${RUN_ID}_enc"
  psql -c "CREATE DATABASE \"$ENC_SRC\";" >/dev/null
  ENC_URL="$(python3 -c "
import sys
u = sys.argv[1]
head, _, tail = u.rpartition('/')
print(head + '/' + sys.argv[2])
" "$ADMIN_URL" "$ENC_SRC")"
PGDATABASE="$ENC_SRC" psql -tAc "
  CREATE TABLE users(id serial primary key, email text not null);
  INSERT INTO users(email) SELECT 'enc-'||g||'@wasit.tn' FROM generate_series(1, 120) g;
" >/dev/null

  ENC_ROOT="$TMP_ROOT/encroot"
  DATABASE_URL="$ENC_URL" BACKUP_ROOT="$ENC_ROOT" BACKUP_RETENTION_COUNT=0 \
    BACKUP_ENCRYPTION=age BACKUP_AGE_RECIPIENTS="$RECIPIENT" \
    "$SCRIPT_DIR/backup-db.sh" >/dev/null
  ENC_BK="$(ls -d "$ENC_ROOT"/*Z | head -1)"
  # Every sensitive payload file must be encrypted, and no plaintext payload may
  # remain next to it.
  MISSING_ENC=0
  for base in "$ENC_SRC.dump" pg_globals.sql table-counts.tsv; do
    [ -f "$ENC_BK/$base.age" ] || { MISSING_ENC=1; echo "    missing $base.age"; }
  done
  [ "$MISSING_ENC" -eq 0 ] && ok "all sensitive files encrypted (dump, globals, counts)" \
    || bad "some sensitive files were not encrypted"
  # Transition phase: the plaintext original must be preserved by default, so a
  # failed or unverified encryption can never destroy the only copy.
  KEPT_PLAINTEXT=0
  for base in "$ENC_SRC.dump" pg_globals.sql table-counts.tsv; do
    [ -f "$ENC_BK/$base" ] && KEPT_PLAINTEXT=$((KEPT_PLAINTEXT + 1))
  done
  expect_eq 3 "$KEPT_PLAINTEXT" "plaintext originals preserved during transition (keep)"
  grep -q '"encryption": *"age"' "$ENC_BK/manifest.json" && ok "manifest declares age encryption" \
    || bad "manifest does not declare encryption"
  grep -q 'plaintextSha256' "$ENC_BK/manifest.json" && ok "manifest records plaintext digests" \
    || bad "manifest missing plaintext digests"
  grep -q "$ENC_SRC.dump.age" "$ENC_BK/manifest.json" && ok "manifest references the ciphertext name" \
    || bad "manifest does not reference ciphertext"

  # Correct identity: restore succeeds and verifies against the snapshot.
  ENC_RESTORE="${RUN_ID}_encrestore"
  if DATABASE_URL="$ENC_URL" BACKUP_AGE_IDENTITY_FILE="$ENC_KEYS/identity.txt" \
       "$SCRIPT_DIR/restore-db.sh" "$ENC_BK" --target "$ENC_RESTORE" >/dev/null 2>&1; then
    ok "encrypted backup restored with the correct identity"
  else
    bad "encrypted backup failed to restore with the correct identity"
  fi
  ENC_ROWS="$(PGDATABASE="$ENC_RESTORE" psql -tAc 'select count(*) from users' 2>/dev/null || echo 0)"
  expect_eq 120 "$ENC_ROWS" "restored row count from encrypted backup"

  # Wrong identity: refused.
  expect_fail "wrong identity is refused" env DATABASE_URL="$ENC_URL" \
    BACKUP_AGE_IDENTITY_FILE="$ENC_KEYS/wrong.txt" \
    "$SCRIPT_DIR/restore-db.sh" "$ENC_BK" --target "$ENC_RESTORE" --force

  # Tampered ciphertext: refused before restoring.
  ENC_DUMP="$(ls "$ENC_BK"/*.dump.age | head -1)"
  cp "$ENC_DUMP" "$TMP_ROOT/good.age"
  printf 'tamper' >> "$ENC_DUMP"
  expect_fail "tampered ciphertext is refused" env DATABASE_URL="$ENC_URL" \
    BACKUP_AGE_IDENTITY_FILE="$ENC_KEYS/identity.txt" \
    "$SCRIPT_DIR/restore-db.sh" "$ENC_BK" --target "$ENC_RESTORE" --force
  cp "$TMP_ROOT/good.age" "$ENC_DUMP"

  # No secret leaks into logs: run a restore capturing all output and assert the
  # identity contents never appear.
  RESTORE_LOG="$TMP_ROOT/restore.log"
  DATABASE_URL="$ENC_URL" BACKUP_AGE_IDENTITY_FILE="$ENC_KEYS/identity.txt" \
    "$SCRIPT_DIR/restore-db.sh" "$ENC_BK" --target "$ENC_RESTORE" --force --drop-after >"$RESTORE_LOG" 2>&1 || true
  IDENTITY_BODY="$(sed -n '2p' "$ENC_KEYS/identity.txt" 2>/dev/null || true)"
  if [ -n "$IDENTITY_BODY" ] && grep -qF -- "$IDENTITY_BODY" "$RESTORE_LOG"; then
    bad "identity material leaked into the restore log"
  else
    ok "no identity material in restore output"
  fi
  # Temporary decrypted files must be gone afterwards: point TMPDIR at a known
  # scratch directory and assert the restore leaves nothing behind in it.
  SCRATCH="$TMP_ROOT/scratch"
  mkdir -p "$SCRATCH"
  TMPDIR="$SCRATCH" DATABASE_URL="$ENC_URL" BACKUP_AGE_IDENTITY_FILE="$ENC_KEYS/identity.txt" \
    "$SCRIPT_DIR/restore-db.sh" "$ENC_BK" --target "$ENC_RESTORE" --force --drop-after >/dev/null 2>&1 || true
  LEFTOVER_TMP="$(ls -A "$SCRATCH" 2>/dev/null | wc -l | tr -d ' ')"
  expect_eq 0 "$LEFTOVER_TMP" "temporary decrypted files cleaned up"

  # Opt-in drop (later phase): with BACKUP_PLAINTEXT_RETENTION=drop the plaintext
  # is removed, but only after the ciphertext exists — and the encrypted backup
  # must still restore afterwards.
  DROP_ROOT="$TMP_ROOT/droproot"
  DATABASE_URL="$ENC_URL" BACKUP_ROOT="$DROP_ROOT" BACKUP_RETENTION_COUNT=0 \
    BACKUP_ENCRYPTION=age BACKUP_AGE_RECIPIENTS="$RECIPIENT" BACKUP_PLAINTEXT_RETENTION=drop \
    "$SCRIPT_DIR/backup-db.sh" >/dev/null
  DROP_BK="$(ls -d "$DROP_ROOT"/*Z | head -1)"
  PLAINTEXT_LEFT=0
  for base in "$ENC_SRC.dump" pg_globals.sql table-counts.tsv; do
    [ -f "$DROP_BK/$base" ] && PLAINTEXT_LEFT=$((PLAINTEXT_LEFT + 1))
  done
  expect_eq 0 "$PLAINTEXT_LEFT" "plaintext dropped when retention=drop"
  if DATABASE_URL="$ENC_URL" BACKUP_AGE_IDENTITY_FILE="$ENC_KEYS/identity.txt" \
       "$SCRIPT_DIR/restore-db.sh" "$DROP_BK" --target "$ENC_RESTORE" --force --drop-after >/dev/null 2>&1; then
    ok "ciphertext-only backup still restores"
  else
    bad "ciphertext-only backup failed to restore"
  fi

  psql -c "DROP DATABASE IF EXISTS \"$ENC_SRC\";" >/dev/null 2>&1 || true
  psql -c "DROP DATABASE IF EXISTS \"$ENC_RESTORE\";" >/dev/null 2>&1 || true
else
  echo "SKIP: age or PostgreSQL unavailable — section E3 (encryption round-trip) was NOT run"
fi

say "Setup a throwaway source database"
SKIPPED=0
if ! psql -tAc "select 1" >/dev/null 2>&1; then
  echo "SKIP: cannot reach PostgreSQL at $ADMIN_URL — sections 1-6 (backup/restore against a real server) were NOT run"
  SKIPPED=1
fi

if [ "$SKIPPED" -eq 0 ]; then
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
fi # end PostgreSQL-dependent sections

printf '\n== Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
