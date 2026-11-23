#!/usr/bin/env bash
# Optional: generate the new password on the production host itself.
#
#   ./generate-password.sh --dry-run
#   ./generate-password.sh --email owner@example.com
#
# This is the recommended alternative to moving the password generated in a
# development environment across a channel you do not control: the secret is
# created where it will be used and never travels.
#
# It only writes the file. Nothing is applied to any account; apply it with
#   ./rotate.sh --email <address> --password-file <path> --reason "..."
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

DRY_RUN="false"
EMAIL="${GM_EMAIL:-}"
VAULT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --email)
      EMAIL="${2:-}"
      [[ -n "${EMAIL}" ]] || die "--email needs a value"
      shift 2
      ;;
    --vault)
      VAULT="${2:-}"
      [[ -n "${VAULT}" ]] || die "--vault needs a path"
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

VAULT_DIR="${WASIT_SECRETS_DIR:-${HOME}/.wasit-secrets}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${VAULT:-${VAULT_DIR}/gm-super-admin-password-${STAMP}.txt}"

note "generator: 32 characters, upper + lower + digit + symbol, from the OS CSPRNG"
note "directory: $(dirname "${TARGET}") (0700)"
note "file:      ${TARGET} (0600)"
note "printed:   never — the file is the only copy"
note "applied:   no — this step does not touch any account"

if [[ "${DRY_RUN}" == "true" ]]; then
  note ""
  note "dry run: nothing was created."
  exit 0
fi

require_node
resolve_cli

ARGS=(generate-password --vault "${TARGET}" --confirm)
[[ -n "${EMAIL}" ]] && ARGS+=(--email "${EMAIL}")
run_cli "${ARGS[@]}"
