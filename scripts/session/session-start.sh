#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-start: prove the workspace is safe to work in.
#
# Answers, before any edit: which repo/branch am I on, does GitHub have commits
# I do not, do I have commits GitHub does not, is anything uncommitted, and
# which important files live only on this box?
#
# Exit codes: 0 = SAFE to start, 1 = UNSAFE (reasons printed), 3 = not a repo.
#
# Usage:
#   ./scripts/session/session-start.sh [--no-fetch] [--report-only]
#
#   --no-fetch      use the refs already on disk (offline); the remote is then
#                   reported as UNVERIFIED and the verdict is UNSAFE.
#   --report-only   print the report but always exit 0 (human inspection).

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/session-common.sh"

DO_FETCH=1
REPORT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-fetch) DO_FETCH=0 ;;
    --report-only) REPORT_ONLY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) serr "unknown option: $arg"; exit 3 ;;
  esac
done

session_enter_repo "$PWD"

BRANCH="$(session_branch)"
HEAD_SHA="$(session_head)"
REMOTE_URL="$(session_sanitize_url "$(session_remote_url origin)")"
UPSTREAM=""
UNSAFE=()
WARN=()

shead "WASIT session start — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
slog "repo     : $(session_root)"
slog "remote   : ${REMOTE_URL:-<none>}"
slog "branch   : $BRANCH"
slog "HEAD     : ${HEAD_SHA:-<no commit>}"

if session_is_detached; then
  UNSAFE+=("HEAD is detached — commits here are not on a branch and are easy to lose")
fi

# --- Remote state -----------------------------------------------------------
shead "Remote state"
if [ "$DO_FETCH" -eq 1 ]; then
  if session_fetch origin 60; then
    sok "fetched origin"
  else
    swarn "could not fetch origin (offline?) — remote state is UNVERIFIED"
    UNSAFE+=("remote state unverified: fetch failed")
  fi
else
  swarn "skipped fetch (--no-fetch) — remote state is UNVERIFIED"
  UNSAFE+=("remote state unverified: --no-fetch")
fi

if UPSTREAM="$(session_upstream "$BRANCH")"; then
  read -r BEHIND AHEAD < <(session_ahead_behind "$UPSTREAM")
  UP_SHA="$(git rev-parse --verify --quiet "$UPSTREAM" || true)"
  slog "upstream : $UPSTREAM (${UP_SHA:0:12})"
  slog "ahead    : $AHEAD commit(s) not on $UPSTREAM"
  slog "behind   : $BEHIND commit(s) on $UPSTREAM not local"
  if [ "$AHEAD" -gt 0 ]; then
    UNSAFE+=("$AHEAD local commit(s) are not on $UPSTREAM — push them or protect them first")
  fi
  if [ "$BEHIND" -gt 0 ]; then
    UNSAFE+=("local branch is $BEHIND commit(s) behind $UPSTREAM — sync before starting work")
  fi
else
  UNSAFE+=("branch '$BRANCH' has no upstream on origin — nothing is durably saved")
  slog "upstream : <none>"
fi

# --- Local unsaved work -----------------------------------------------------
shead "Local unsaved work"
STAGED=$(session_staged_count); UNSTAGED=$(session_unstaged_count)
UNTRACKED=$(session_untracked_count); CONFLICTS=$(session_conflict_count)
STASHES=$(session_stash_count)
slog "staged    : $STAGED"
slog "unstaged  : $UNSTAGED"
slog "untracked : $UNTRACKED"
slog "conflicts : $CONFLICTS"
slog "stashes   : $STASHES"
if [ "$STAGED" -gt 0 ] || [ "$UNSTAGED" -gt 0 ] || [ "$UNTRACKED" -gt 0 ]; then
  UNSAFE+=("working tree is not clean ($STAGED staged / $UNSTAGED unstaged / $UNTRACKED untracked)")
fi
if [ "$CONFLICTS" -gt 0 ]; then
  UNSAFE+=("$CONFLICTS path(s) have unresolved merge conflicts")
fi
if [ "$STASHES" -gt 0 ]; then
  UNSAFE+=("$STASHES stash entries hold work Git does not track on any branch")
fi

if [ "$UNTRACKED" -gt 0 ]; then
  slog ""
  slog "untracked files:"
  git ls-files --others --exclude-standard | head -20 | sed 's/^/  - /'
  if [ "$UNTRACKED" -gt 20 ]; then slog "  … and $((UNTRACKED - 20)) more"; fi
fi

# --- Ignored but important --------------------------------------------------
shead "Ignored files that only exist on this machine"
IMPORTANT="$(session_important_ignored_files || true)"
if [ -n "$IMPORTANT" ]; then
  printf '%s\n' "$IMPORTANT" | head -20 | sed 's/^/  - /'
  COUNT=$(printf '%s\n' "$IMPORTANT" | grep -c . || true)
  if [ "$COUNT" -gt 20 ]; then slog "  … and $((COUNT - 20)) more"; fi
  WARN+=("$COUNT ignored file(s) are not protected by Git — copy them before the container dies")
else
  sok "none"
fi

# --- Recovery assets --------------------------------------------------------
shead "Recovery assets"
BUNDLES="$(session_list_bundles || true)"
if [ -n "$BUNDLES" ]; then
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    AGE=$(session_fmt_age "$(stat -c %Y "$b")")
    SHA="$(sha256sum "$b" | awk '{print $1}')"
    slog "  - $b (${AGE} old, sha256 ${SHA:0:16}…)"
  done <<< "$BUNDLES"
else
  swarn "no git bundles found — run scripts/session/session-backup.sh to create one"
  WARN+=("no independent git bundle exists yet")
fi

# --- Verdict ----------------------------------------------------------------
shead "Verdict"
if [ "${#UNSAFE[@]}" -eq 0 ]; then
  sok "SAFE — workspace matches GitHub, nothing unsaved"
  VERDICT=0
else
  serr "UNSAFE — do not start new work until these are resolved:"
  for r in "${UNSAFE[@]}"; do printf '  • %s\n' "$r" >&2; done
  VERDICT=1
fi
if [ "${#WARN[@]}" -gt 0 ]; then
  swarn "warnings:"
  for w in "${WARN[@]}"; do printf '  • %s\n' "$w" >&2; done
fi

if [ "$REPORT_ONLY" -eq 1 ]; then
  exit 0
fi
exit "$VERDICT"
