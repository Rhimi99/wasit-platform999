#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — session-selftest: prove the continuity system works.
#
# Runs the whole lifecycle in a throwaway directory, against a THROWAWAY branch
# on GitHub (never master): clean clone -> edit -> checkpoint -> push -> lose the
# workspace -> clone again -> compare -> dirty/ignored/unpushed detection ->
# close refusal -> secret refusal -> push failure and recovery -> bundle restore
# and SHA-256 verification.
#
# The real workspace is never modified: the source repository is only read from,
# and every experiment happens under a `mktemp -d` directory that this script
# deletes when it finishes (unless --keep).
#
# Usage:
#   ./scripts/session/session-selftest.sh [--keep] [--branch-suffix NAME]
#
# Exit codes: 0 = all scenarios passed, 1 = at least one failed (temp dir kept).

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(cd "$SELF_DIR/../.." && pwd)"

KEEP=0
SUFFIX=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --branch-suffix) SUFFIX="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 3 ;;
  esac
done

command -v git >/dev/null || { echo "git is required" >&2; exit 3; }

REPO_URL="$(git -C "$SOURCE_REPO" remote get-url origin)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BRANCH="session-selftest-${STAMP}${SUFFIX:+-$SUFFIX}"
[ "$BRANCH" != "master" ] || { echo "refusing to run on master" >&2; exit 3; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wasit-session-selftest.XXXXXX")"
LOGS="$WORK/logs"
mkdir -p "$LOGS"

PASS=0; FAIL=0
declare -a RESULTS=()
CURRENT=0

ok()  { PASS=$((PASS+1)); RESULTS+=("PASS|$1"); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("FAIL|$1"); printf '  \033[31m✖\033[0m %s\n' "$1"; }
step() { CURRENT=$((CURRENT+1)); printf '\n\033[1m[%02d] %s\033[0m\n' "$CURRENT" "$1"; }

# run <log-name> <cmd...> — captures output, returns the command's status.
run() {
  local name="$1"; shift
  "$@" > "$LOGS/$name.log" 2>&1
}
show_log() { sed 's/^/      /' "$LOGS/$1.log" | tail -12; }

cleanup() {
  if [ "$KEEP" -eq 1 ] || [ "$FAIL" -gt 0 ]; then
    printf '\nTemp workspace kept for inspection: %s\n' "$WORK"
  else
    rm -rf -- "$WORK"
  fi
}
trap cleanup EXIT

printf 'WASIT session-continuity selftest\n'
printf 'source repo : %s\n' "$SOURCE_REPO"
printf 'remote      : %s\n' "$(printf '%s' "$REPO_URL" | sed -E 's#(://)[^@/]+@#\1***@#')"
printf 'test branch : %s\n' "$BRANCH"
printf 'work dir    : %s\n' "$WORK"

# --- 1. Clean clone ---------------------------------------------------------
step "1. clean clone + session-start reports SAFE"
if run 01-clone git clone -q "$REPO_URL" "$WORK/repo-a"; then
  ok "cloned $REPO_URL"
else
  bad "clone failed"; show_log 01-clone; exit 1
fi
if run 01-start "$WORK/repo-a/scripts/session/session-start.sh" --report-only; then
  if grep -q "SAFE — workspace matches GitHub" "$LOGS/01-start.log"; then
    ok "session-start: SAFE on a clean clone"
  else
    bad "session-start did not report SAFE"; show_log 01-start
  fi
else
  bad "session-start exited non-zero on a clean clone"; show_log 01-start
fi

# --- 2-3. Edit + checkpoint -------------------------------------------------
step "2-3. edit a fixture, then checkpoint it"
mkdir -p "$WORK/repo-a/docs/session"
printf 'selftest fixture\ncreated: %s\n' "$STAMP" > "$WORK/repo-a/docs/session/selftest-fixture.txt"
printf 'second line\n' >> "$WORK/repo-a/docs/session/selftest-fixture.txt"
if run 03-switch git -C "$WORK/repo-a" switch -c "$BRANCH"; then
  ok "created test branch $BRANCH (master untouched)"
else
  bad "could not create the test branch"; show_log 03-switch
fi
if run 03-checkpoint "$WORK/repo-a/scripts/session/session-checkpoint.sh" -m "test: session selftest checkpoint"; then
  ok "checkpoint committed and pushed"
else
  bad "checkpoint failed"; show_log 03-checkpoint
fi
SHA_A="$(git -C "$WORK/repo-a" rev-parse HEAD)"

# --- 4-5. Verify on GitHub --------------------------------------------------
step "4-5. the checkpoint really exists on GitHub"
REMOTE_SHA="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$REPO_URL" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')"
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" = "$SHA_A" ]; then
  ok "origin/$BRANCH == ${SHA_A:0:12}"
else
  bad "remote head '${REMOTE_SHA:-none}' != local '${SHA_A:0:12}'"
fi

# --- 6-9. Simulate losing the workspace, restore from GitHub ----------------
step "6-9. lose the workspace, clone fresh, compare the commit and the file"
if mv "$WORK/repo-a" "$WORK/repo-a-lost"; then
  ok "workspace moved away (simulated loss, nothing deleted)"
else
  bad "could not simulate workspace loss"
fi
if run 07-clone2 git clone -q --branch "$BRANCH" "$REPO_URL" "$WORK/repo-b"; then
  ok "fresh clone restored the test branch"
else
  bad "fresh clone failed"; show_log 07-clone2
fi
SHA_B="$(git -C "$WORK/repo-b" rev-parse HEAD 2>/dev/null || echo none)"
if [ "$SHA_B" = "$SHA_A" ]; then
  ok "restored HEAD == lost HEAD (${SHA_A:0:12})"
else
  bad "restored HEAD ${SHA_B:0:12} != ${SHA_A:0:12}"
fi
FILE_A="$(sha256sum "$WORK/repo-a-lost/docs/session/selftest-fixture.txt" 2>/dev/null | awk '{print $1}')"
FILE_B="$(sha256sum "$WORK/repo-b/docs/session/selftest-fixture.txt" 2>/dev/null | awk '{print $1}')"
if [ -n "$FILE_A" ] && [ "$FILE_A" = "$FILE_B" ]; then
  ok "restored file matches byte-for-byte (sha256 ${FILE_A:0:16}…)"
else
  bad "restored file differs (${FILE_A:0:16}… vs ${FILE_B:0:16}…)"
fi

# --- 10-13. Detect unsaved work and refuse to close -------------------------
step "10. untracked files are detected"
printf 'scratch\n' > "$WORK/repo-b/untracked-note.txt"
run 10-status "$WORK/repo-b/scripts/session/session-status.sh" --strict
if [ $? -eq 1 ] && grep -q "untracked 1" "$LOGS/10-status.log"; then
  ok "session-status --strict exits 1 and reports 1 untracked file"
else
  bad "untracked file not detected"; show_log 10-status
fi

step "11. ignored-but-important files are detected"
printf 'DEMO=1\n' > "$WORK/repo-b/.env"
run 11-status "$WORK/repo-b/scripts/session/session-status.sh"
if grep -q "^  - \.env$" "$LOGS/11-status.log"; then
  ok ".env listed under 'ignored but important'"
else
  bad ".env not listed"; show_log 11-status
fi

step "12. unpushed commits are detected"
run 12-commit git -C "$WORK/repo-b" commit -qam "test: local-only commit" --allow-empty
run 12-status "$WORK/repo-b/scripts/session/session-status.sh" --strict
if [ $? -eq 1 ] && grep -q "ahead    : 1" "$LOGS/12-status.log"; then
  ok "session-status reports 1 unpushed commit and exits 1"
else
  bad "unpushed commit not detected"; show_log 12-status
fi

step "13. session-close refuses an unsafe workspace"
run 13-close "$WORK/repo-b/scripts/session/session-close.sh"
if [ $? -eq 1 ] && grep -q "NOT SAFE TO CLOSE" "$LOGS/13-close.log"; then
  ok "session-close refused (dirty tree + unpushed commit + .env)"
else
  bad "session-close did not refuse"; show_log 13-close
fi

# --- 14. Secret refusal -----------------------------------------------------
step "14. checkpoint refuses staged secrets"
HEAD_BEFORE="$(git -C "$WORK/repo-b" rev-parse HEAD)"
# Deliberately fake: shape of a GitHub token, no real credential.
printf 'token = "ghp_%s"\n' "$(printf 'A%.0s' {1..36})" > "$WORK/repo-b/secret-fixture.txt"
run 14-checkpoint "$WORK/repo-b/scripts/session/session-checkpoint.sh" -m "test: must be refused"
STATUS=$?
HEAD_AFTER="$(git -C "$WORK/repo-b" rev-parse HEAD)"
if [ "$STATUS" -eq 1 ] && grep -q "github-token" "$LOGS/14-checkpoint.log" && [ "$HEAD_BEFORE" = "$HEAD_AFTER" ]; then
  ok "refused the secret, created no commit, leaked no value"
else
  bad "secret was not refused (status=$STATUS)"; show_log 14-checkpoint
fi
rm -f -- "$WORK/repo-b/secret-fixture.txt"

# --- 15. Push failure and recovery -----------------------------------------
step "15. a network failure during push is reported, then recovered"
printf 'push-failure line\n' >> "$WORK/repo-b/docs/session/selftest-fixture.txt"
git -C "$WORK/repo-b" remote set-url origin "http://127.0.0.1:9/wasit-unreachable.git"
run 15-checkpoint-fail "$WORK/repo-b/scripts/session/session-checkpoint.sh" -m "test: push will fail"
STATUS=$?
LOCAL_SHA="$(git -C "$WORK/repo-b" rev-parse HEAD)"
if [ "$STATUS" -eq 1 ] && grep -q "NOT on GitHub" "$LOGS/15-checkpoint-fail.log" && [ "$LOCAL_SHA" != "$HEAD_AFTER" ]; then
  ok "commit kept locally, failure reported, nothing forced"
else
  bad "push failure not handled (status=$STATUS)"; show_log 15-checkpoint-fail
fi
git -C "$WORK/repo-b" remote set-url origin "$REPO_URL"
run 15-checkpoint-retry "$WORK/repo-b/scripts/session/session-checkpoint.sh" --push-only
if [ $? -eq 0 ]; then
  RETRY_SHA="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$REPO_URL" "refs/heads/$BRANCH" | awk '{print $1}')"
  if [ "$RETRY_SHA" = "$LOCAL_SHA" ]; then
    ok "--push-only recovered the interrupted push (origin == ${LOCAL_SHA:0:12})"
  else
    bad "recovered push did not reach GitHub"
  fi
else
  bad "--push-only retry failed"; show_log 15-checkpoint-retry
fi

# --- 16. Bundle backup + restore -------------------------------------------
step "16. bundle backup, SHA-256 verification and restore"
if run 16-backup "$WORK/repo-b/scripts/session/session-backup.sh" --dest "$WORK/bundles" --label selftest; then
  ok "bundle created"
else
  bad "bundle creation failed"; show_log 16-backup
fi
BUNDLE="$(find "$WORK/bundles" -maxdepth 1 -name 'wasit-*.bundle' | head -1)"
BUNDLE_SHA="$(sha256sum "$BUNDLE" | awk '{print $1}')"
if run 16-recovery "$WORK/repo-b/scripts/session/session-recovery.sh" \
    --bundle "$BUNDLE" --sha256 "$BUNDLE_SHA" --repo "$REPO_URL" \
    --branch "$BRANCH" --target "$WORK/repo-c"; then
  ok "restored from the bundle into a new directory"
else
  bad "bundle restore failed"; show_log 16-recovery
fi
SHA_C="$(git -C "$WORK/repo-c" rev-parse HEAD 2>/dev/null || echo none)"
if [ "$SHA_C" = "$LOCAL_SHA" ]; then
  ok "bundle-restored HEAD == source HEAD (${LOCAL_SHA:0:12})"
else
  bad "bundle-restored HEAD ${SHA_C:0:12} != ${LOCAL_SHA:0:12}"
fi

step "16b. a corrupted bundle is refused (SHA-256 mismatch)"
cp "$BUNDLE" "$WORK/tampered.bundle"
printf '\x00' | dd of="$WORK/tampered.bundle" bs=1 seek=2048 conv=notrunc status=none
run 16-tampered "$WORK/repo-b/scripts/session/session-recovery.sh" \
  --bundle "$WORK/tampered.bundle" --sha256 "$BUNDLE_SHA" --target "$WORK/repo-d"
if [ $? -eq 1 ] && grep -q "SHA-256 mismatch" "$LOGS/16-tampered.log"; then
  ok "tampered bundle refused before any write"
else
  bad "tampered bundle was not refused"; show_log 16-tampered
fi

step "16c. a safe workspace closes cleanly"
if run 16c-close "$WORK/repo-c/scripts/session/session-close.sh"; then
  ok "session-close: SAFE TO CLOSE on the restored workspace"
else
  bad "session-close refused a safe workspace"; show_log 16c-close
fi

# --- Summary ----------------------------------------------------------------
printf '\n\033[1mSummary\033[0m\n'
printf '  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
printf '  results:\n'
for r in "${RESULTS[@]}"; do printf '    %s\n' "$r"; done

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
