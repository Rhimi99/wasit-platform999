#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-close: refuse to end a session unsafely.
#
# Runs the final gate. It never "fixes" anything: it only reports, and exits
# non-zero when the session would end with work that exists nowhere else.
#
# Exit codes: 0 = safe to close, 1 = unsafe (reasons printed), 3 = not a repo.
#
# Usage:
#   ./scripts/session/session-close.sh [--no-fetch] [--ack-ignored] [--ack-stash]
#
#   --no-fetch     do not contact GitHub (the remote check then FAILS by design:
#                  an unverified close is not a safe close)
#   --ack-ignored  acknowledge that the listed ignored files are backed up
#                  outside Git (they can never be committed)
#   --ack-stash    acknowledge that stash entries were reviewed and are
#                  intentionally left behind

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/session-common.sh"

DO_FETCH=1
ACK_IGNORED=0
ACK_STASH=0
for arg in "$@"; do
  case "$arg" in
    --no-fetch) DO_FETCH=0 ;;
    --ack-ignored) ACK_IGNORED=1 ;;
    --ack-stash) ACK_STASH=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) serr "unknown option: $arg"; exit 3 ;;
  esac
done

session_enter_repo "$PWD"

BRANCH="$(session_branch)"
HEAD_SHA="$(session_head)"
FAIL=()
NOTE=()

shead "WASIT session close — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
slog "branch : $BRANCH"
slog "HEAD   : ${HEAD_SHA:-<no commit>}"

if session_is_detached; then
  FAIL+=("HEAD is detached — no branch points at this commit")
fi

# --- 1. Conflicts -----------------------------------------------------------
CONFLICTS="$(session_conflict_count)"
if [ "$CONFLICTS" -gt 0 ]; then
  FAIL+=("$CONFLICTS path(s) still have unresolved conflicts")
else
  sok "no unresolved conflicts"
fi

# --- 2. Uncommitted work ----------------------------------------------------
STAGED="$(session_staged_count)"; UNSTAGED="$(session_unstaged_count)"; UNTRACKED="$(session_untracked_count)"
if [ "$STAGED" -gt 0 ] || [ "$UNSTAGED" -gt 0 ] || [ "$UNTRACKED" -gt 0 ]; then
  FAIL+=("working tree is not clean ($STAGED staged / $UNSTAGED unstaged / $UNTRACKED untracked)")
  slog ""
  slog "unsaved paths:"
  { git diff --cached --name-only; git diff --name-only; git ls-files --others --exclude-standard; } \
    | sort -u | head -25 | sed 's/^/  - /'
else
  sok "working tree clean (no staged, unstaged or untracked files)"
fi

# --- 3. Stashes -------------------------------------------------------------
STASHES="$(session_stash_count)"
if [ "$STASHES" -gt 0 ]; then
  if [ "$ACK_STASH" -eq 1 ]; then
    NOTE+=("$STASHES stash entries acknowledged")
  else
    FAIL+=("$STASHES stash entries hold work that is on no branch and no remote")
  fi
fi

# --- 4. Unpushed commits ----------------------------------------------------
UNPUSHED="$(session_unpushed_count "$BRANCH")"
if [ "$UNPUSHED" -gt 0 ]; then
  FAIL+=("$UNPUSHED commit(s) are not on origin/$BRANCH")
  git --no-pager log --oneline "origin/$BRANCH..HEAD" 2>/dev/null | head -10 | sed 's/^/  • /' || true
else
  sok "no unpushed commits"
fi

# --- 5. Remote verification -------------------------------------------------
shead "Remote verification"
if [ "$DO_FETCH" -eq 1 ] && session_fetch origin 60; then
  REMOTE_SHA="$(session_remote_head "$BRANCH" || true)"
  if [ -z "$REMOTE_SHA" ]; then
    FAIL+=("origin/$BRANCH does not exist — this branch is local-only")
  elif [ "$REMOTE_SHA" != "$HEAD_SHA" ]; then
    FAIL+=("origin/$BRANCH=${REMOTE_SHA:0:12} but local HEAD=${HEAD_SHA:0:12}")
  else
    sok "origin/$BRANCH == ${HEAD_SHA:0:12}"
  fi
else
  FAIL+=("could not verify GitHub (fetch failed or --no-fetch) — an unverified close is unsafe")
fi

# --- 6. Ignored-but-important files ----------------------------------------
IMPORTANT="$(session_important_ignored_files || true)"
if [ -n "$IMPORTANT" ]; then
  COUNT=$(printf '%s\n' "$IMPORTANT" | grep -c . || true)
  if [ "$ACK_IGNORED" -eq 1 ]; then
    NOTE+=("$COUNT ignored file(s) acknowledged by the operator — this tool cannot verify an external copy")
  else
    FAIL+=("$COUNT ignored file(s) exist only on this machine (e.g. .env, dumps, media)")
    printf '%s\n' "$IMPORTANT" | head -10 | sed 's/^/  • /' >&2
    serr "copy them somewhere durable, or pass --ack-ignored to accept the risk"
  fi
else
  sok "no important ignored files"
fi

# --- Verdict ----------------------------------------------------------------
shead "Verdict"
if [ "${#FAIL[@]}" -eq 0 ]; then
  sok "SAFE TO CLOSE — GitHub holds everything this session produced"
  for n in "${NOTE[@]:-}"; do [ -n "$n" ] && swarn "$n"; done
  exit 0
fi

serr "NOT SAFE TO CLOSE:"
for f in "${FAIL[@]}"; do printf '  • %s\n' "$f" >&2; done
printf '\n' >&2
serr "run: scripts/session/session-checkpoint.sh -m \"<message>\" [--allow-master]"
exit 1
