#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — shared helpers for the session-continuity tools.
#
# Sourced, never executed. Every function here is read-only against Git except
# the ones whose name says otherwise (fetch/push live in the callers). The
# guiding rule: GitHub is the durable source of truth, so these helpers must be
# able to answer "what is local, what is remote, and what is only on this box?"
# without ever touching a working tree, a branch or a ref.

set -euo pipefail

SESSION_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_SCRIPTS_DIR="$(cd "$SESSION_LIB_DIR/.." && pwd)"
SESSION_REPO_ROOT="$(cd "$SESSION_SCRIPTS_DIR/../.." && pwd)"

# --- Output -----------------------------------------------------------------
# Colour only on a TTY so CI logs and piped output stay parseable.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

slog()  { printf '%s\n' "$*"; }
sok()   { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
swarn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
serr()  { printf '%s✖%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
shead() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

session_require() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 || { serr "required tool '$tool' not found in PATH"; exit 3; }
}

# --- Repository identity ----------------------------------------------------
# Never echo a remote URL verbatim: it may carry credentials in the userinfo
# part (https://token@github.com/...). Strip everything before '@'.
session_sanitize_url() {
  printf '%s\n' "$1" | sed -E 's#(://)[^@/]+@#\1***@#'
}

session_enter_repo() {
  session_require git
  if ! git -C "${1:-$PWD}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    serr "not inside a git work tree: ${1:-$PWD}"
    exit 3
  fi
  cd "$(git -C "${1:-$PWD}" rev-parse --show-toplevel)"
}

session_root()      { git rev-parse --show-toplevel; }
session_branch()    { git symbolic-ref --quiet --short HEAD 2>/dev/null || printf '(detached HEAD)'; }
session_head()      { git rev-parse --verify HEAD 2>/dev/null || true; }
session_short()     { git rev-parse --short "$1" 2>/dev/null || true; }
session_is_detached() { ! git symbolic-ref --quiet HEAD >/dev/null 2>&1; }

session_remote_url() {
  local remote="${1:-origin}"
  git remote get-url "$remote" 2>/dev/null || true
}

# origin/<branch> even when the local branch has no upstream configured.
session_upstream() {
  local branch="$1" up
  if up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    printf '%s\n' "$up"
    return 0
  fi
  if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
    printf 'origin/%s\n' "$branch"
    return 0
  fi
  return 1
}

# Echo "behind ahead" (commits) against the upstream ref.
session_ahead_behind() {
  local upstream="$1"
  git rev-list --left-right --count "$upstream...HEAD" 2>/dev/null || echo "0 0"
}

session_unpushed_count() {
  local branch="$1" upstream
  if ! upstream="$(session_upstream "$branch")"; then
    # No upstream: every commit on this branch is unpushed as far as we know.
    git rev-list --count HEAD 2>/dev/null || echo 0
    return 0
  fi
  git rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0
}

# --- Working tree -----------------------------------------------------------
session_staged_count()    { git diff --cached --name-only | grep -c . || true; }
session_unstaged_count()  { git diff --name-only | grep -c . || true; }
session_untracked_count() { git ls-files --others --exclude-standard | grep -c . || true; }

session_dirty_count() {
  git status --porcelain | grep -c . || true
}

# Unmerged paths (conflict markers still present in the index).
session_conflict_count() { git ls-files --unmerged | cut -f2 | sort -u | grep -c . || true; }

session_stash_count() { git stash list 2>/dev/null | grep -c . || true; }

# --- Ignored-but-important files -------------------------------------------
# `.gitignore` is doing its job (secrets and build output must not be
# committed), but that also means Git will never protect them. Anything that
# matches these patterns is reported so an agent knows it needs an external
# copy before the container dies.
session_is_important_ignored() {
  local path="$1"
  case "$path" in
    */node_modules/*|node_modules/*) return 1 ;;
  esac
  case "$path" in
    .env|.env.*|*/.env|*/.env.*)
      case "$path" in
        *.example|*.sample|*.template) return 1 ;;
      esac
      return 0 ;;
    *.pem|*.key|*.p12|*.pfx|*.jks|*.keystore|*.kdbx) return 0 ;;
    *.dump|*.bundle|*.sqlite|*.sqlite3|*.db) return 0 ;;
    # The session tooling's own output directory IS the protection; listing it
    # as unprotected would make every close fail right after a backup.
    backups/git/*) return 1 ;;
    backups/*|storage/*|e2e/.auth/*|packages/server/.wasit-media/*) return 0 ;;
  esac
  return 1
}

session_important_ignored_files() {
  local path
  git status --ignored --porcelain 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      '!! '*) path="${line#!! }" ;;
      *) continue ;;
    esac
    # A directory entry ends with '/': expand it so the pattern check sees files.
    case "$path" in
      */)
        git ls-files --others --ignored --exclude-standard -- "$path" 2>/dev/null
        ;;
      *)
        printf '%s\n' "$path"
        ;;
    esac
  done | while IFS= read -r p; do
    if session_is_important_ignored "$p"; then printf '%s\n' "$p"; fi
  done | sort -u
}

# --- Secrets ----------------------------------------------------------------
# Only *added* lines of the staged diff are scanned, and only high-confidence
# shapes. A finding prints the pattern label and the file — never the value.
SESSION_SECRET_ALLOWLIST="$SESSION_SCRIPTS_DIR/secret-allowlist.txt"

session_secret_patterns() {
  cat <<'PATTERNS'
private-key-block|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----
github-token|gh[pousr]_[A-Za-z0-9]{30,}
github-pat|github_pat_[A-Za-z0-9_]{50,}
openai-key|sk-[A-Za-z0-9]{32,}
aws-access-key|AKIA[0-9A-Z]{16}
slack-token|xox[abposr]-[A-Za-z0-9-]{10,}
google-api-key|AIza[0-9A-Za-z_-]{35}
google-oauth|ya29\.[0-9A-Za-z_-]{20,}
generic-secret-assignment|(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/+_.-]{16,}["'"'"']
PATTERNS
}

session_secret_filename_hit() {
  local path="$1"
  case "$path" in
    .env|.env.*|*/.env|*/.env.*)
      case "$path" in
        *.example|*.sample|*.template) return 1 ;;
      esac
      return 0 ;;
    *.pem|*.key|*.p12|*.pfx|*.jks|*.keystore) return 0 ;;
    id_rsa|id_ed25519|*/id_rsa|*/id_ed25519) return 0 ;;
    *credentials*.json|*service-account*.json) return 0 ;;
  esac
  return 1
}

# Scan staged additions. Prints "file\tpattern-label" lines; exit 1 when a hit
# exists so callers can block a commit.
session_scan_staged_secrets() {
  local hits=0 file label regex line allowed
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if session_secret_filename_hit "$file"; then
      printf '%s\t%s\n' "$file" "sensitive-filename"
      hits=1
      continue
    fi
    # Only text additions; -U0 keeps context out of the grep.
    while IFS= read -r line; do
      case "$line" in
        '+'*) ;;
        *) continue ;;
      esac
      allowed=0
      if [ -f "$SESSION_SECRET_ALLOWLIST" ]; then
        while IFS= read -r a || [ -n "$a" ]; do
          [ -n "$a" ] || continue
          case "$a" in '#'*) continue ;; esac
          case "$line" in *"$a"*) allowed=1; break ;; esac
        done < "$SESSION_SECRET_ALLOWLIST"
      fi
      [ "$allowed" -eq 1 ] && continue
      while IFS='|' read -r label regex; do
        [ -n "$label" ] || continue
        if printf '%s\n' "$line" | grep -Eq -- "$regex"; then
          printf '%s\t%s\n' "$file" "$label"
          hits=1
        fi
      done < <(session_secret_patterns)
    done < <(git diff --cached -U0 -- "$file" 2>/dev/null | grep -E '^\+' || true)
  done < <(git diff --cached --name-only --diff-filter=ACMR)

  return $([ "$hits" -eq 0 ] && echo 0 || echo 1)
}

# --- Remote -----------------------------------------------------------------
# Echo the remote branch head or nothing. A network failure must be
# distinguishable from "branch does not exist": the caller checks the exit code.
session_remote_head() {
  local branch="$1" remote="${2:-origin}" out
  out="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$remote" "refs/heads/$branch" 2>/dev/null)" || return 2
  printf '%s\n' "$out" | awk '{print $1}' | head -1
}

session_fetch() {
  local remote="${1:-origin}" timeout_s="${2:-60}"
  GIT_TERMINAL_PROMPT=0 timeout "$timeout_s" git fetch --prune "$remote" >/dev/null 2>&1
}

# --- Recovery assets --------------------------------------------------------
session_recovery_dir() { printf '%s\n' "${WASIT_RECOVERY_DIR:-/workspace/recovery}"; }
session_bundle_dir()   { printf '%s\n' "${WASIT_BUNDLE_DIR:-$(session_root)/backups/git}"; }

session_list_bundles() {
  local dir
  for dir in "$(session_bundle_dir)" "$(session_recovery_dir)"; do
    [ -d "$dir" ] || continue
    find "$dir" -maxdepth 2 -type f -name '*.bundle' -print0 2>/dev/null \
      | xargs -0 -r ls -1t 2>/dev/null || true
  done | sort -u
}

# --- Formatting -------------------------------------------------------------
session_fmt_age() {
  local ts="$1" now
  now=$(date +%s)
  local delta=$(( now - ts ))
  if [ "$delta" -lt 60 ]; then echo "${delta}s"
  elif [ "$delta" -lt 3600 ]; then echo "$((delta / 60))m"
  elif [ "$delta" -lt 86400 ]; then echo "$((delta / 3600))h"
  else echo "$((delta / 86400))d"; fi
}
