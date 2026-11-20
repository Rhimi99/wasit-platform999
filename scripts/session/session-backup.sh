#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-backup: a self-contained Git bundle + manifest.
#
# A bundle is the one artefact that survives the loss of both this container and
# the GitHub account: it is a single file holding every ref, restorable with
# `git clone <file>`. It is written under backups/git/ which .gitignore excludes,
# and this script refuses to write anywhere Git would track.
#
# Usage:
#   ./scripts/session/session-backup.sh [--dest DIR] [--label NAME] [--keep N] [--prune]
#
# Options:
#   --dest DIR     where to write (default: <repo>/backups/git, or $WASIT_BUNDLE_DIR)
#   --label NAME   suffix for the file name (e.g. before-obs02)
#   --keep N       retention target (default 10); only used with --prune
#   --prune        delete OLD bundles beyond the retention target. Never runs by
#                  default, never deletes anything younger than 7 days, and only
#                  touches files matching wasit-*.bundle in the destination.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/session-common.sh"

DEST=""
LABEL=""
KEEP="${SESSION_BUNDLE_KEEP:-10}"
PRUNE=0
MIN_AGE_DAYS="${SESSION_BUNDLE_MIN_AGE_DAYS:-7}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --prune) PRUNE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) serr "unknown option: $1"; exit 3 ;;
  esac
done

session_enter_repo "$PWD"
session_require sha256sum

[ -n "$DEST" ] || DEST="$(session_bundle_dir)"

# Refuse to write inside the repository unless Git ignores the path: a 12 MB
# binary in a public repository is both noise and a leak risk. A destination
# outside the work tree (an attached disk, /tmp, a mounted volume) is allowed.
DEST_ABS="$(realpath -m "$DEST")"
ROOT_ABS="$(session_root)"
case "$DEST_ABS" in
  "$ROOT_ABS"|"$ROOT_ABS"/*)
    if ! git check-ignore -q "$DEST_ABS/probe.bundle" 2>/dev/null; then
      serr "destination '$DEST_ABS' is inside the repository and not git-ignored"
      serr "add it to .gitignore or choose an external --dest"
      exit 1
    fi
    ;;
esac

mkdir -p "$DEST"
chmod 0700 "$DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="wasit-${STAMP}${LABEL:+-$LABEL}.bundle"
FINAL="$DEST/$NAME"
TMP="$DEST/.$NAME.partial"

HEAD_SHA="$(session_head)"
BRANCH="$(session_branch)"

shead "Creating bundle"
slog "dest : $DEST"
slog "head : ${HEAD_SHA:0:12} ($BRANCH)"

# Write to a partial name so an interrupted run never leaves a bundle that looks
# valid; only a verified file gets its final name.
git bundle create "$TMP" --all >/dev/null
git bundle verify "$TMP" >/dev/null
mv "$TMP" "$FINAL"

SHA="$(sha256sum "$FINAL" | awk '{print $1}')"
SIZE="$(stat -c %s "$FINAL")"
REFS="$(git bundle list-heads "$FINAL" | wc -l)"

sok "bundle written: $FINAL"
slog "  size   : $SIZE bytes"
slog "  sha256 : $SHA"
slog "  refs   : $REFS"

# --- Manifest ---------------------------------------------------------------
MANIFEST="$DEST/manifest.tsv"
LINE="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' \
  "$STAMP" "$SHA" "$SIZE" "$HEAD_SHA" "$BRANCH" "$REFS" "$NAME")"

if [ ! -f "$MANIFEST" ]; then
  printf 'timestamp\tsha256\tsize_bytes\thead\tbranch\trefs\tbundle\n' > "$MANIFEST"
fi
if command -v flock >/dev/null 2>&1; then
  flock "$MANIFEST.lock" bash -c 'printf "%s\n" "$1" >> "$2"' _ "$LINE" "$MANIFEST"
else
  printf '%s\n' "$LINE" >> "$MANIFEST"
fi
chmod 0600 "$MANIFEST"
sok "manifest updated: $MANIFEST"

# --- Retention (opt-in only) ------------------------------------------------
if [ "$PRUNE" -eq 1 ]; then
  shead "Retention (keep=$KEEP, min-age=${MIN_AGE_DAYS}d)"
  CUTOFF=$(( $(date +%s) - MIN_AGE_DAYS * 86400 ))
  # Tab-separated so a path containing spaces survives the sort/cut.
  mapfile -t OLD < <(find "$DEST" -maxdepth 1 -type f -name 'wasit-*.bundle' -printf '%T@\t%p\n' \
    | sort -rn | tail -n "+$((KEEP + 1))" | cut -f2-)
  for f in "${OLD[@]:-}"; do
    [ -n "$f" ] || continue
    MTIME="$(stat -c %Y "$f")"
    if [ "$MTIME" -gt "$CUTOFF" ]; then
      slog "  keep (too new): $(basename "$f")"
      continue
    fi
    rm -f -- "$f"
    slog "  pruned: $(basename "$f")"
  done
else
  slog ""
  slog "retention: not pruned (pass --prune to apply keep=$KEEP)"
fi

shead "Restore check (safe, read-only)"
slog "  git clone \"$FINAL\" <new-empty-dir>"
slog "  or: scripts/session/session-recovery.sh --bundle \"$FINAL\" --sha256 $SHA --target <new-empty-dir>"
