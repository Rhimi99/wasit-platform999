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
#   BACKUP_DIR_MODE         permission mode for the backup tree (default 0700)
#   BACKUP_ENCRYPTION       "off" (default) or "age"
#   BACKUP_AGE_RECIPIENTS   age recipient(s), whitespace/newline separated (age mode)
#   BACKUP_AGE_RECIPIENTS_FILE  file of recipients, one per line (age mode)
#   BACKUP_AGE_BIN          path to the age binary if not on PATH
#   BACKUP_PLAINTEXT_RETENTION  "keep" (default) or "drop" (age mode only)
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

# Encryption mode. `off` is the default and keeps the historical behaviour byte
# for byte; `age` encrypts every payload file. The tool and recipients are
# checked here, before any database is touched, so a misconfiguration fails fast.
ENCRYPTION="${BACKUP_ENCRYPTION:-off}"
case "$ENCRYPTION" in
  off) ;;
  age)
    wasit_require_age
    AGE_BIN="$(wasit_age_bin)"
    ;;
  *)
    echo "ERROR: BACKUP_ENCRYPTION must be 'off' or 'age' (got '$ENCRYPTION')" >&2
    exit 1
    ;;
esac

# Plaintext-retention policy (age mode only). Validated here — before any
# database is touched — so an unknown value stops the run outright instead of
# risking an unintended drop later. `keep` is the default.
if [ "$ENCRYPTION" = "age" ]; then
  PLAINTEXT_RETENTION="${BACKUP_PLAINTEXT_RETENTION:-keep}"
  case "$PLAINTEXT_RETENTION" in
    keep|drop) ;;
    *)
      echo "ERROR: BACKUP_PLAINTEXT_RETENTION must be 'keep' or 'drop' (got '$PLAINTEXT_RETENTION')" >&2
      exit 1
      ;;
  esac
fi

# Restrictive permissions on the backup tree: a backup holds database contents
# (including role password hashes), so it must not be world-readable. Modes are
# set explicitly rather than inherited from the caller's umask, and only the
# backup tree itself is touched.
wasit_secure_dir "$BACKUP_ROOT" "${BACKUP_DIR_MODE:-0700}"
LOCK_FILE="$BACKUP_ROOT/.backup.lock"
# Serialise: a long dump and the next scheduled run must not interleave and
# prune each other's in-progress folder.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "== Another backup is already running; exiting." >&2
  exit 0
fi

wasit_secure_dir "$OUT_DIR" "${BACKUP_DIR_MODE:-0700}"

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

# --- Optional payload encryption (BACKUP_ENCRYPTION=age) ---
# Every payload file is encrypted to the configured recipients before the
# manifest is written, so the manifest and checksums describe the encrypted
# artefacts a restore will actually consume. Verification here is structural
# (non-empty, correct age header): the backup host deliberately holds no private
# identity, so it cannot decrypt its own output — the round trip is proven by
# the restore drill instead.
#
# During this transition phase the plaintext files are kept by default (nothing
# is deleted); BACKUP_PLAINTEXT_RETENTION=drop removes them, and is meant for
# after the encrypted restore drill has passed. The plaintext is only ever
# dropped after every ciphertext was written and structurally verified, so a
# failed encryption can never destroy the only copy.
if [ "$ENCRYPTION" = "age" ]; then
  AGE_RECIPIENT_ARGS=()
  while IFS= read -r recipient; do
    [ -n "$recipient" ] || continue
    case "$recipient" in \#*) continue ;; esac
    AGE_RECIPIENT_ARGS+=(-r "$recipient")
  done < <(wasit_age_recipients)

  encrypt_payload() {
    local src="$1" out="$1.age"
    "$AGE_BIN" --encrypt "${AGE_RECIPIENT_ARGS[@]}" --output "$out" "$src"
    if [ ! -s "$out" ] || [ "$(head -c 21 "$out")" != "age-encryption.org/v1" ]; then
      echo "ERROR: encryption produced no valid ciphertext for $(basename "$src")" >&2
      return 1
    fi
  }

  echo "== Encrypting payload with age"
  for f in "$OUT_DIR"/*.dump "$OUT_DIR/pg_globals.sql" "$TABLE_COUNTS_FILE"; do
    [ -f "$f" ] || continue
    encrypt_payload "$f" || exit 1
  done
  # The manifest records the files a restore must read, so it names the
  # ciphertext, not the plaintext.
  DB_ENTRIES="${DB_ENTRIES//.dump\"/.dump.age\"}"
fi

# The files the manifest describes: ciphertext in age mode, plaintext otherwise.
MANIFEST_FILES=()
for f in "$OUT_DIR"/*.dump "$OUT_DIR/pg_globals.sql" "$TABLE_COUNTS_FILE"; do
  [ -f "$f" ] || continue
  if [ "$ENCRYPTION" = "age" ]; then
    MANIFEST_FILES+=("$f.age")
  else
    MANIFEST_FILES+=("$f")
  fi
done
TABLE_COUNTS_NAME="table-counts.tsv"
[ "$ENCRYPTION" = "age" ] && TABLE_COUNTS_NAME="table-counts.tsv.age"

# Build the manifest with real digests so restore can prove integrity.
{
  printf '{\n'
  printf '  "createdAt": "%s",\n' "$CREATED_AT"
  printf '  "postgresClientVersion": "%s",\n' "$PG_VERSION"
  printf '  "serverVersion": "%s",\n' "$SERVER_VERSION"
  printf '  "sourceHost": "%s",\n' "$PGHOST"
  # Off-mode output stays byte-for-byte what it was before encryption existed.
  if [ "$ENCRYPTION" = "age" ]; then
    printf '  "encryption": "%s",\n' "$ENCRYPTION"
    printf '  "recipients": ['
    first_r=1
    for r in "${AGE_RECIPIENT_ARGS[@]}"; do
      case "$r" in -r) continue ;; esac
      [ "$first_r" -eq 1 ] || printf ', '
      first_r=0
      printf '"%s"' "$r"
    done
    printf '],\n'
  fi
  printf '  "databases": [%s],\n' "$DB_ENTRIES"
  printf '  "tableCountsFile": "%s",\n' "$TABLE_COUNTS_NAME"
  printf '  "files": {\n'
  first=1
  for f in "${MANIFEST_FILES[@]}"; do
    name="$(basename "$f")"
    digest="$(sha256sum "$f" | awk '{print $1}')"
    size="$(stat -c %s "$f")"
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    if [ "$ENCRYPTION" = "age" ]; then
      pdigest="$(sha256sum "${f%.age}" | awk '{print $1}')"
      printf '    "%s": { "sha256": "%s", "bytes": %s, "plaintextSha256": "%s", "algo": "age-x25519" }' \
        "$name" "$digest" "$size" "$pdigest"
    else
      printf '    "%s": { "sha256": "%s", "bytes": %s }' "$name" "$digest" "$size"
    fi
  done
  printf '\n  }\n'
  printf '}\n'
} > "$OUT_DIR/manifest.json"

# A standard `sha256sum` file so restore can verify with `sha256sum -c` and no
# JSON parser (the restore may run from a slim image with only coreutils). In age
# mode it covers the ciphertext and the manifest, i.e. exactly what is shipped.
if [ "$ENCRYPTION" = "age" ]; then
  ( cd "$OUT_DIR" && sha256sum ./*.age ./manifest.json > checksums.sha256 )
else
  ( cd "$OUT_DIR" && sha256sum ./*.dump ./pg_globals.sql ./*.tsv > checksums.sha256 )
fi

# Re-read the checksums file we just wrote and verify it against the artefacts on
# disk *before* any plaintext is dropped. If it does not check out, the run stops
# here — while the plaintext still exists — and the EXIT trap removes the folder.
verify_checksums_file() {
  local file="$1" out
  # Without --status, sha256sum names the failing entry on stderr; the output is
  # captured, not printed, so a success stays quiet.
  if ! out="$( cd "$OUT_DIR" && sha256sum -c "$file" 2>&1 )"; then
    echo "ERROR: checksums verification failed for $file: $out" >&2
    return 1
  fi
}
verify_checksums_file checksums.sha256 || exit 1

# Plaintext is dropped only now: every ciphertext exists and was verified, the
# manifest recorded the plaintext digests, and checksums.sha256 was written and
# re-verified. Each target is re-checked against the *current* OUT_DIR — no
# symlink, and the canonical path must sit directly inside it — so a drop can
# never reach a previous backup folder or any file outside the tree.
if [ "$ENCRYPTION" = "age" ] && [ "${PLAINTEXT_RETENTION:-keep}" = "drop" ]; then
  echo "== Dropping plaintext payload (BACKUP_PLAINTEXT_RETENTION=drop)"
  OUT_DIR_REAL="$(cd "$OUT_DIR" && pwd -P)"
  for f in "$OUT_DIR"/*.dump "$OUT_DIR/pg_globals.sql" "$TABLE_COUNTS_FILE"; do
    [ -e "$f" ] || continue
    # Never follow or remove a symlink: that is exactly how a drop could be aimed
    # at a file outside the backup tree.
    if [ -L "$f" ]; then
      echo "ERROR: refusing to drop symlinked payload '$f'" >&2
      exit 1
    fi
    [ -f "$f" ] || continue
    f_real="$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")"
    case "$f_real" in
      "$OUT_DIR_REAL"/*) ;;
      *)
        echo "ERROR: refusing to drop '$f' (resolves outside the backup folder)" >&2
        exit 1
        ;;
    esac
    rm -f -- "$f_real"
  done
fi

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
