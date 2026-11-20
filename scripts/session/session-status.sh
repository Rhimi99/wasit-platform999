#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-status: one screen with the whole picture.
#
# Local state, remote state and the independent bundles, in one report. Read
# only: it never stages, commits, fetches into a branch, or deletes.
#
# Usage:
#   ./scripts/session/session-status.sh [--fetch] [--strict]
#
#   --fetch   refresh origin refs before reporting (default: use what is on disk
#             and ask GitHub only for the remote head via ls-remote)
#   --strict  exit 1 when the workspace is not safe (same rules as session-close)

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/session-common.sh"

DO_FETCH=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --fetch) DO_FETCH=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) serr "unknown option: $arg"; exit 3 ;;
  esac
done

session_enter_repo "$PWD"

BRANCH="$(session_branch)"
HEAD_SHA="$(session_head)"
UNSAFE=()

shead "WASIT session status — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
slog "repo   : $(session_root)"
slog "remote : $(session_sanitize_url "$(session_remote_url origin)")"
slog "branch : $BRANCH"
slog "HEAD   : ${HEAD_SHA:-<no commit>} ($(git log -1 --format='%s' 2>/dev/null || echo 'no commit'))"

if [ "$DO_FETCH" -eq 1 ]; then
  if session_fetch origin 60; then sok "fetched origin"; else swarn "fetch failed"; fi
fi

shead "Local vs remote"
if UPSTREAM="$(session_upstream "$BRANCH")"; then
  read -r BEHIND AHEAD < <(session_ahead_behind "$UPSTREAM")
  slog "upstream : $UPSTREAM"
  slog "ahead    : $AHEAD"
  slog "behind   : $BEHIND"
  if [ "$AHEAD" -gt 0 ]; then UNSAFE+=("$AHEAD unpushed commit(s)"); fi
  if [ "$BEHIND" -gt 0 ]; then UNSAFE+=("$BEHIND commit(s) behind the remote"); fi
else
  slog "upstream : <none>"
  UNSAFE+=("branch has no upstream on origin")
fi
REMOTE_SHA="$(session_remote_head "$BRANCH" || true)"
if [ -n "$REMOTE_SHA" ]; then
  slog "origin/$BRANCH : ${REMOTE_SHA:0:12}"
  [ "$REMOTE_SHA" = "$HEAD_SHA" ] && sok "local HEAD matches origin/$BRANCH" || swarn "local HEAD differs from origin/$BRANCH"
else
  swarn "origin/$BRANCH could not be read (offline, or the branch is local-only)"
fi

shead "Working tree"
STAGED=$(session_staged_count); UNSTAGED=$(session_unstaged_count)
UNTRACKED=$(session_untracked_count); CONFLICTS=$(session_conflict_count)
STASHES=$(session_stash_count)
slog "staged $STAGED · unstaged $UNSTAGED · untracked $UNTRACKED · conflicts $CONFLICTS · stashes $STASHES"
if [ "$STAGED" -gt 0 ] || [ "$UNSTAGED" -gt 0 ] || [ "$UNTRACKED" -gt 0 ]; then
  UNSAFE+=("working tree not clean")
  { git diff --cached --name-only; git diff --name-only; git ls-files --others --exclude-standard; } \
    | sort -u | head -15 | sed 's/^/  - /'
fi
if [ "$CONFLICTS" -gt 0 ]; then UNSAFE+=("unresolved conflicts"); fi
if [ "$STASHES" -gt 0 ]; then UNSAFE+=("stash entries present"); fi

shead "Ignored but important (not protected by Git)"
IMPORTANT="$(session_important_ignored_files || true)"
if [ -n "$IMPORTANT" ]; then
  printf '%s\n' "$IMPORTANT" | head -10 | sed 's/^/  - /'
  COUNT=$(printf '%s\n' "$IMPORTANT" | grep -c . || true)
  if [ "$COUNT" -gt 10 ]; then slog "  … and $((COUNT - 10)) more"; fi
else
  sok "none"
fi

shead "Independent bundles"
BUNDLES="$(session_list_bundles || true)"
if [ -n "$BUNDLES" ]; then
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    AGE=$(session_fmt_age "$(stat -c %Y "$b")")
    SHA=$(sha256sum "$b" | awk '{print $1}')
    SIZE=$(du -h "$b" | cut -f1)
    slog "  - $b  ($SIZE, ${AGE} old)"
    slog "    sha256 $SHA"
  done <<< "$BUNDLES"
else
  swarn "none — run scripts/session/session-backup.sh"
  UNSAFE+=("no independent bundle")
fi

MANIFEST="$(session_bundle_dir)/manifest.tsv"
if [ -f "$MANIFEST" ]; then
  shead "Bundle manifest (last 5)"
  tail -5 "$MANIFEST" | sed 's/^/  /'
fi

shead "Verdict"
if [ "${#UNSAFE[@]}" -eq 0 ]; then
  sok "durable — everything is on GitHub and a bundle exists"
else
  swarn "not durable yet:"
  for u in "${UNSAFE[@]}"; do printf '  • %s\n' "$u" >&2; done
  if [ "$STRICT" -eq 1 ]; then exit 1; fi
fi
exit 0
