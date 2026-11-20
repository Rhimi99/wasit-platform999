#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-recovery: rebuild a workspace after the
# container (and its project directory) is gone.
#
# Two sources are supported and both are verified before use:
#   * GitHub (default)               — needs network and read access
#   * a Git bundle (--bundle)        — needs nothing but the file
#
# The target directory must not exist, or must be empty. This tool never
# overwrites, never deletes and never "repairs" an existing checkout; if the
# target is occupied it stops and tells you.
#
# Exit codes: 0 = restored and verified, 1 = refused/failed, 3 = usage error.
#
# Usage:
#   ./scripts/session/session-recovery.sh --target DIR [options]
#
# Options:
#   --target DIR       where to restore (must not exist or be empty) [required]
#   --branch NAME      branch to restore (default: master)
#   --repo URL         source repository (default: this checkout's origin)
#   --bundle FILE      restore from a bundle instead of the network
#   --sha256 HEX       expected SHA-256 of the bundle (required with --bundle
#                      unless --allow-unverified is passed)
#   --allow-unverified accept a bundle whose hash was not provided
#   --dry-run          print the plan without writing anything

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/session-common.sh"

TARGET=""
BRANCH="master"
REPO=""
BUNDLE=""
EXPECTED_SHA=""
ALLOW_UNVERIFIED=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --sha256) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --allow-unverified) ALLOW_UNVERIFIED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) serr "unknown option: $1"; exit 3 ;;
  esac
done

session_require git
session_require sha256sum

[ -n "$TARGET" ] || { serr "--target is required"; exit 3; }

# Resolve the repository URL from the current checkout when not given. Run
# inside a work tree if possible; outside one, --repo is mandatory.
if [ -z "$REPO" ]; then
  if git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REPO="$(git -C "$PWD" remote get-url origin 2>/dev/null || true)"
  fi
fi
if [ -z "$REPO" ] && [ -z "$BUNDLE" ]; then
  serr "--repo is required when not running inside a checkout"
  exit 3
fi

shead "WASIT session recovery — plan"
slog "target : $TARGET"
slog "branch : $BRANCH"
if [ -n "$BUNDLE" ]; then
  slog "source : bundle $BUNDLE"
else
  slog "source : ${REPO:+$(session_sanitize_url "$REPO")}"
fi

# --- Target must be free ----------------------------------------------------
if [ -e "$TARGET" ]; then
  if [ -d "$TARGET" ] && [ -z "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    sok "target exists but is empty — safe to use"
  else
    serr "target '$TARGET' already exists and is not empty — refusing to touch it"
    serr "choose a new path; this tool never overwrites or deletes a workspace"
    exit 1
  fi
fi

# --- Bundle integrity -------------------------------------------------------
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || { serr "bundle not found: $BUNDLE"; exit 1; }
  ACTUAL_SHA="$(sha256sum "$BUNDLE" | awk '{print $1}')"
  slog "sha256 : $ACTUAL_SHA"
  if [ -n "$EXPECTED_SHA" ]; then
    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
      serr "SHA-256 mismatch: expected $EXPECTED_SHA"
      serr "the bundle is corrupted or was replaced — refusing to restore"
      exit 1
    fi
    sok "sha256 matches the expected value"
  elif [ "$ALLOW_UNVERIFIED" -eq 1 ]; then
    swarn "no expected SHA-256 supplied (--allow-unverified) — integrity not proven"
  else
    serr "no --sha256 supplied; refusing to restore an unverified bundle"
    serr "pass --sha256 <hex> (see the manifest) or --allow-unverified to accept the risk"
    exit 1
  fi
  if ! git bundle verify "$BUNDLE" >/dev/null 2>&1; then
    serr "git bundle verify failed — the bundle is not a valid Git bundle"
    exit 1
  fi
  sok "git bundle verify passed"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  slog ""
  sok "dry run — nothing was written"
  exit 0
fi

# --- Restore ----------------------------------------------------------------
shead "Restoring"
mkdir -p "$(dirname "$TARGET")"

if [ -n "$BUNDLE" ]; then
  git clone -q "$BUNDLE" "$TARGET"
  if [ -n "$REPO" ]; then
    git -C "$TARGET" remote set-url origin "$REPO"
  else
    git -C "$TARGET" remote remove origin
  fi
  if [ -n "$REPO" ]; then
    # A bundle clone has no fetch refspec; without one, `fetch origin <branch>`
    # updates only FETCH_HEAD and the restored checkout would look "unpushed".
    git -C "$TARGET" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    GIT_TERMINAL_PROMPT=0 git -C "$TARGET" fetch -q --prune origin || {
      swarn "could not fetch origin — restoring from the bundle refs only"
    }
  fi
else
  GIT_TERMINAL_PROMPT=0 git clone -q --branch "$BRANCH" "$REPO" "$TARGET"
fi

cd "$TARGET"
if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  git switch -q -C "$BRANCH" --track "origin/$BRANCH" 2>/dev/null \
    || git switch -q "$BRANCH" 2>/dev/null \
    || true
elif git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  git switch -q "$BRANCH"
fi

# --- Verify -----------------------------------------------------------------
shead "Verification"
HEAD_SHA="$(git rev-parse HEAD)"
slog "HEAD        : $HEAD_SHA"
slog "branch      : $(session_branch)"
slog "last commit : $(git log -1 --format='%h %s')"
slog "commits     : $(git rev-list --count HEAD)"

if git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  REMOTE_SHA="$(git rev-parse "refs/remotes/origin/$BRANCH")"
  slog "origin/$BRANCH: $REMOTE_SHA"
  if [ "$HEAD_SHA" = "$REMOTE_SHA" ]; then
    sok "restored HEAD matches origin/$BRANCH"
  else
    serr "restored HEAD does not match origin/$BRANCH"
    exit 1
  fi
fi

DIRTY="$(session_dirty_count)"
if [ "$DIRTY" -eq 0 ]; then sok "working tree clean"; else swarn "$DIRTY modified path(s) after restore"; fi

shead "Recovery report"
sok "workspace restored at $TARGET"
slog "next: cd \"$TARGET\" && ./scripts/session/session-start.sh"
