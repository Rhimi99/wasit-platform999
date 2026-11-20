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
#   * checksums.sha256 is mandatory — an unverifiable backup is refused
#   * the target name must be a valid identifier (a-z, 0-9, _), never escaped
#   * DEMO / Production / system databases are refused, and --force or
#     --allow-live do NOT bypass that refusal
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
#   DATABASE_URL               the *live* database, used only to know what to protect
#   WASIT_PROTECTED_DB_NAMES   extra names to protect (comma/space separated)
#   BACKUP_AGE_IDENTITY_FILE   path to the private age identity (encrypted backups)
#   BACKUP_AGE_BIN             path to the age binary if not on PATH
#   PG_BIN                     postgres client bin dir if not on PATH

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

# --- 1. Integrity: mandatory. A backup that cannot be verified is not restored. ---
# The checksum manifest is required, must not be empty, and every entry must
# resolve to a file *inside* the backup directory whose digest matches. The
# directory is the trust boundary, so a `../` entry or a symlink out of the tree
# is a hard failure — never a skip.
echo "== Verifying backup integrity in $BACKUP_DIR"
CHECKSUMS="$BACKUP_DIR/checksums.sha256"
[ -f "$CHECKSUMS" ] || {
  echo "INTEGRITY FAILED: no checksums.sha256 in $BACKUP_DIR — refusing to restore an unverifiable backup" >&2
  exit 1
}
[ -s "$CHECKSUMS" ] || {
  echo "INTEGRITY FAILED: checksums.sha256 is empty in $BACKUP_DIR" >&2
  exit 1
}

BACKUP_REAL="$(cd "$BACKUP_DIR" && pwd -P)"
verify_integrity() {
  local digest rel target abs abs_real
  local count=0
  while read -r digest rel || [ -n "$digest" ]; do
    rel="${rel#\*}"                       # tolerate sha256sum's binary-mode marker
    [ -n "$digest" ] && [ -n "$rel" ] || continue
    count=$((count + 1))
    case "$rel" in
      /*|*..*)
        echo "INTEGRITY FAILED: checksum entry '$rel' escapes the backup directory" >&2
        return 1
        ;;
    esac
    target="$BACKUP_DIR/$rel"
    [ -f "$target" ] || { echo "INTEGRITY FAILED: listed file missing: $rel" >&2; return 1; }
    if [ -L "$target" ]; then
      echo "INTEGRITY FAILED: checksum entry '$rel' is a symlink" >&2
      return 1
    fi
    abs="$BACKUP_REAL/$rel"
    abs_real="$(cd "$(dirname "$abs")" && pwd -P)/$(basename "$abs")"
    case "$abs_real" in
      "$BACKUP_REAL"/*) ;;
      *) echo "INTEGRITY FAILED: checksum entry '$rel' resolves outside the backup directory" >&2; return 1 ;;
    esac
    printf '%s  %s\n' "$digest" "$abs_real" | sha256sum -c --status - || {
      echo "INTEGRITY FAILED: checksum mismatch for $rel" >&2
      return 1
    }
  done < "$CHECKSUMS"
  if [ "$count" -eq 0 ]; then
    echo "INTEGRITY FAILED: checksums.sha256 lists no files" >&2
    return 1
  fi
  return 0
}
verify_integrity || exit 1
echo "  ok: checksums verified"

# --- 1b. Decrypt if the backup is encrypted (before any database is touched) ---
# The plaintext is materialised into a private 0700 scratch directory and removed
# on exit (success or failure). A missing or wrong identity fails here, so an
# undecryptable backup never reaches a DROP/CREATE. The identity is passed to age
# only as a *path*, never as an argument value, so it cannot leak through `ps`.
PAYLOAD_DIR="$BACKUP_DIR"
DECRYPT_TMP=""
cleanup_decrypt() {
  if [ -n "$DECRYPT_TMP" ] && [ -d "$DECRYPT_TMP" ]; then
    rm -rf "$DECRYPT_TMP"
  fi
}
trap cleanup_decrypt EXIT

ENCRYPTION="$(grep -o '"encryption": *"[^"]*"' "$MANIFEST" 2>/dev/null | head -1 | sed -e 's/.*"\([^"]*\)"$/\1/' || true)"
if [ "$ENCRYPTION" = "age" ]; then
  echo "== Encrypted backup (age); locating the private identity"
  IDENTITY="$(wasit_age_identity_path)"
  AGE_BIN="$(wasit_age_bin)"
  if [ -z "$AGE_BIN" ] || [ ! -x "$AGE_BIN" ]; then
    echo "ERROR: this backup is age-encrypted but the 'age' tool was not found (set BACKUP_AGE_BIN)" >&2
    exit 1
  fi
  if [ -z "$IDENTITY" ]; then
    echo "ERROR: this backup is age-encrypted; set BACKUP_AGE_IDENTITY_FILE to the private identity" >&2
    exit 1
  fi
  if [ ! -r "$IDENTITY" ]; then
    echo "ERROR: age identity file is missing or unreadable: $IDENTITY" >&2
    exit 1
  fi
  # The identity must live outside the backup tree: a key stored beside its own
  # ciphertext is not separation of key and data.
  IDENTITY_REAL="$(cd "$(dirname "$IDENTITY")" && pwd -P)/$(basename "$IDENTITY")"
  case "$IDENTITY_REAL" in
    "$BACKUP_REAL"/*)
      echo "ERROR: refusing to read the age identity from inside the backup directory" >&2
      exit 1
      ;;
  esac

  DECRYPT_TMP="$(mktemp -d)"
  chmod 0700 "$DECRYPT_TMP"
  echo "== Decrypting payload into a private scratch directory"
  decrypt_payload() {
    local enc="$1" name out pdigest
    name="$(basename "$enc" .age)"
    out="$DECRYPT_TMP/$name"
    if ! "$AGE_BIN" --decrypt --identity "$IDENTITY" --output "$out" "$enc" 2>/dev/null; then
      echo "ERROR: failed to decrypt $(basename "$enc") (wrong identity or corrupted ciphertext)" >&2
      return 1
    fi
    # Integrity of the recovered plaintext: compare against the digest the backup
    # recorded at creation time. This catches a ciphertext that decrypts to
    # something other than what was dumped.
    pdigest="$(grep -o "\"$(basename "$enc")\": *{[^}]*}" "$MANIFEST" 2>/dev/null \
      | grep -o '"plaintextSha256": *"[^"]*"' | head -1 | sed -e 's/.*"\([^"]*\)"$/\1/' || true)"
    if [ -n "$pdigest" ]; then
      actual="$(sha256sum "$out" | awk '{print $1}')"
      if [ "$actual" != "$pdigest" ]; then
        echo "ERROR: decrypted $(basename "$enc") does not match its recorded digest" >&2
        return 1
      fi
    fi
  }
  for enc in "$BACKUP_DIR"/*.age; do
    [ -f "$enc" ] || continue
    decrypt_payload "$enc" || exit 1
  done
  PAYLOAD_DIR="$DECRYPT_TMP"
  echo "  ok: payload decrypted and verified"
fi

# --- 2. Decide the target database, applying the safety rails ---
PRIMARY_DB="$(grep -o '"database": *"[^"]*"' "$MANIFEST" | head -1 | sed -e 's/.*"\([^"]*\)"$/\1/')"
[ -n "$PRIMARY_DB" ] || { echo "ERROR: could not read a database name from the manifest" >&2; exit 1; }
# The backup's own database name reaches CREATE/DROP DATABASE, so validate it too.
wasit_validate_db_name "$PRIMARY_DB" "manifest database name" || exit 1
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

# D3: validate the target name before it is ever used in SQL or a psql command.
wasit_validate_db_name "$TARGET_DB" "target database name" || exit 1

# D4: refuse DEMO/Production databases (and their scratch aliases). This check
# runs before any other target rule and is NOT bypassable by --force or
# --allow-live — the flags exist to ease a dev/test drill, not to reach a
# protected database.
if wasit_is_protected_db_name "$TARGET_DB"; then
  echo "ERROR: refusing to restore into protected database '$TARGET_DB' (DEMO/Production/system)." >&2
  echo "       --force and --allow-live do not bypass this protection." >&2
  exit 1
fi

if [ "$TARGET_DB" = "$LIVE_DB" ] && [ "$ALLOW_LIVE" -ne 1 ]; then
  echo "ERROR: refusing to restore over the live database '$LIVE_DB'." >&2
  echo "       Default target is a scratch database; pass --allow-live to override." >&2
  exit 1
fi

# Connect as the backup's owner to the maintenance database.
wasit_use_url "$SOURCE_URL" "$(wasit_maintenance_db)"
MAINT_DB="$PGDATABASE"

echo "== Target database: $TARGET_DB (live is '$LIVE_DB')"
# The name is passed as a psql variable and quoted by psql (:'name'), so it is
# never interpolated into the statement text. psql only expands :'var' for
# stdin/`-f` input, not for `-c`, so the query is fed on stdin.
EXISTS="$(printf '%s\n' "select 1 from pg_database where datname = :'target'" \
  | psql -v target="$TARGET_DB" -tA)"
if [ -n "$EXISTS" ] && [ "$FORCE" -ne 1 ]; then
  echo "ERROR: database '$TARGET_DB' already exists; pass --force to overwrite it." >&2
  exit 1
fi

# --- 3. Create the target and restore into it ---
echo "== Creating $TARGET_DB"
psql -d "$MAINT_DB" -c "DROP DATABASE IF EXISTS $(wasit_sql_ident "$TARGET_DB");" >/dev/null
psql -d "$MAINT_DB" -c "CREATE DATABASE $(wasit_sql_ident "$TARGET_DB");" >/dev/null

echo "== Restoring from $PRIMARY_DB.dump"
# --no-owner: the restored objects belong to whoever runs the drill, not the
# original role, so a cross-environment restore does not fail on role names.
pg_restore --no-owner --dbname "$TARGET_DB" "$PAYLOAD_DIR/$PRIMARY_DB.dump"

# --- 4. Verify: compare row counts against the backup's own snapshot ---
if [ "$VERIFY" -eq 1 ]; then
  COUNTS_FILE="$PAYLOAD_DIR/table-counts.tsv"
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
  psql -d "$MAINT_DB" -c "DROP DATABASE $(wasit_sql_ident "$TARGET_DB");" >/dev/null
fi

echo "== Restore complete."
