#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-checkpoint: commit safe work and push it.
#
# A checkpoint is a small, tested commit that is pushed immediately. It exists
# so that losing the container never costs more than the work since the last
# checkpoint. Nothing here rewrites history, forces a push or touches ignored
# files: `git add` without `-f` cannot stage a `.env`, a dump or a bundle.
#
# Exit codes: 0 = committed and pushed (or nothing to do), 1 = refused/failed,
#             3 = usage error.
#
# Usage:
#   ./scripts/session/session-checkpoint.sh -m "message" [options] [-- paths…]
#
# Options:
#   -m, --message MSG    commit message (required unless --push-only)
#   --no-push            commit locally only (still prints that it is NOT durable)
#   --push-only          push the current HEAD without creating a commit
#   --allow-master       permit a checkpoint on master (default: refuse)
#   --co-author "A <a@b>" append a Co-authored-by trailer
#   --dry-run            show what would be committed, change nothing

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/session-common.sh"

MESSAGE=""
DO_PUSH=1
PUSH_ONLY=0
ALLOW_MASTER=0
CO_AUTHOR=""
DRY_RUN=0
PATHS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    -m|--message) MESSAGE="${2:-}"; shift 2 ;;
    --no-push) DO_PUSH=0; shift ;;
    --push-only) PUSH_ONLY=1; shift ;;
    --allow-master) ALLOW_MASTER=1; shift ;;
    --co-author) CO_AUTHOR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    --) shift; PATHS=("$@"); break ;;
    *) serr "unknown option: $1"; exit 3 ;;
  esac
done

session_enter_repo "$PWD"
BRANCH="$(session_branch)"

if session_is_detached; then
  serr "HEAD is detached — check out a branch before checkpointing (nothing was changed)"
  exit 1
fi

if [ "$BRANCH" = "master" ] && [ "$ALLOW_MASTER" -ne 1 ] && [ "${SESSION_ALLOW_MASTER:-0}" != "1" ]; then
  serr "refusing to checkpoint on master."
  serr "Work on a task branch (git switch -c task/<name>), or pass --allow-master"
  serr "when the maintainer-approved flow is a fast-forward commit on master."
  exit 1
fi

# --- Push-only --------------------------------------------------------------
if [ "$PUSH_ONLY" -eq 1 ]; then
  HEAD_SHA="$(session_head)"
  slog "push-only: $BRANCH @ ${HEAD_SHA:0:12} -> origin"
  GIT_TERMINAL_PROMPT=0 git push -u origin "HEAD:refs/heads/$BRANCH" || {
    serr "push failed — nothing was rewritten; fix the cause and retry"
    exit 1
  }
  REMOTE_SHA="$(session_remote_head "$BRANCH" || true)"
  if [ "$REMOTE_SHA" = "$HEAD_SHA" ]; then
    sok "origin/$BRANCH == ${HEAD_SHA:0:12}"
    exit 0
  fi
  serr "remote head (${REMOTE_SHA:-unknown}) does not match local HEAD ($HEAD_SHA)"
  exit 1
fi

if [ -z "$MESSAGE" ]; then
  serr "-m/--message is required"
  exit 3
fi

# --- Stage ------------------------------------------------------------------
if [ "${#PATHS[@]}" -gt 0 ]; then
  git add -- "${PATHS[@]}"
else
  git add -A
fi

STAGED="$(session_staged_count)"
if [ "$STAGED" -eq 0 ]; then
  sok "nothing to checkpoint — working tree has no committable changes"
  if [ "$DO_PUSH" -eq 1 ]; then
    UNPUSHED="$(session_unpushed_count "$BRANCH")"
    if [ "$UNPUSHED" -gt 0 ]; then
      swarn "$UNPUSHED commit(s) are still unpushed; run with --push-only"
    fi
  fi
  exit 0
fi

shead "Checkpoint contents ($STAGED file(s))"
git diff --cached --stat | tail -20

# --- Secret gate ------------------------------------------------------------
shead "Secret scan (staged additions)"
if SECRET_HITS="$(session_scan_staged_secrets)"; then
  sok "no secrets detected"
else
  serr "checkpoint refused — the staged changes look like they contain secrets:"
  printf '%s\n' "$SECRET_HITS" | sort -u | while IFS=$'\t' read -r f p; do
    printf '  • %s (%s)\n' "$f" "$p" >&2
  done
  serr "remove the value (use an env var / a redacted fixture), then retry."
  serr "files remain staged; nothing was committed and nothing was pushed."
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  slog ""
  sok "dry run — no commit, no push"
  exit 0
fi

# --- Commit -----------------------------------------------------------------
shead "Commit"
if [ -n "$CO_AUTHOR" ]; then
  git commit -q -m "$MESSAGE" -m "Co-authored-by: $CO_AUTHOR"
else
  git commit -q -m "$MESSAGE"
fi
NEW_SHA="$(session_head)"
sok "committed $(session_short "$NEW_SHA") — $MESSAGE"

if [ "$DO_PUSH" -eq 0 ]; then
  swarn "NOT pushed (--no-push). A local commit is not a backup."
  exit 0
fi

# --- Push (fast-forward only, never forced) ---------------------------------
shead "Push"
GIT_TERMINAL_PROMPT=0 git push -u origin "HEAD:refs/heads/$BRANCH" || {
  serr "push rejected — the commit exists locally but is NOT on GitHub."
  serr "run: git fetch origin && git log --oneline origin/$BRANCH..HEAD"
  serr "then rebase/merge manually. This tool never forces a push."
  exit 1
}

REMOTE_SHA="$(session_remote_head "$BRANCH" || true)"
if [ "$REMOTE_SHA" = "$NEW_SHA" ]; then
  sok "origin/$BRANCH == ${NEW_SHA:0:12}"
else
  serr "verification failed: origin/$BRANCH=${REMOTE_SHA:-unknown} local=$NEW_SHA"
  exit 1
fi
