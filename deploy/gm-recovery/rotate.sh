#!/usr/bin/env bash
# Step 2 of the recovery: replace the password. Requires a human confirmation.
#
#   ./rotate.sh --email owner@example.com --password-file ~/.wasit-secrets/gm.txt --reason "Owner request"
#   ./rotate.sh --email owner@example.com --generate --reason "Owner request"
#
# The password never appears on the command line: either it is read from a 0600
# file, or the CLI generates one into ~/.wasit-secrets and prints only the path.
# Before anything is written the operator must retype the declared database name,
# so a shell that is pointed at the wrong database cannot be answered by reflex.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_email "$@"
shift 2

PASSWORD_FILE=""
GENERATE="false"
REASON=""
VAULT=""
ASSUME_YES="${GM_RECOVERY_ASSUME_YES:-no}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password-file)
      PASSWORD_FILE="${2:-}"
      [[ -n "${PASSWORD_FILE}" ]] || die "--password-file needs a path"
      shift 2
      ;;
    --generate)
      GENERATE="true"
      shift
      ;;
    --reason)
      REASON="${2:-}"
      [[ -n "${REASON}" ]] || die "--reason needs a value"
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

[[ "${GENERATE}" == "true" || -n "${PASSWORD_FILE}" ]] || die "give either --password-file <path> or --generate"
[[ "${GENERATE}" == "true" && -n "${PASSWORD_FILE}" ]] && die "choose one: --password-file or --generate"
[[ -n "${REASON}" ]] || die "--reason is required (it is recorded in the audit trail)"

require_node
require_production_env
resolve_cli

if [[ -n "${PASSWORD_FILE}" ]]; then
  require_private_file "${PASSWORD_FILE}" "password file"
fi

cat <<EOF
About to replace the password of ${EMAIL}
  database:   ${WASIT_PRODUCTION_DB_NAME}
  sessions:   all sessions of this account will be revoked
  unchanged:  roles, email verification, second factor
EOF

if [[ "${ASSUME_YES}" != "yes" ]]; then
  printf 'Type the database name (%s) to continue: ' "${WASIT_PRODUCTION_DB_NAME}"
  read -r ANSWER
  [[ "${ANSWER}" == "${WASIT_PRODUCTION_DB_NAME}" ]] || die "confirmation did not match; nothing was changed"
fi

ARGS=(set-password --email "${EMAIL}" --reason "${REASON}" --confirm)
if [[ -n "${PASSWORD_FILE}" ]]; then
  ARGS+=(--password-file "${PASSWORD_FILE}")
else
  ARGS+=(--generate)
  [[ -n "${VAULT}" ]] && ARGS+=(--vault "${VAULT}")
fi

run_cli "${ARGS[@]}"
