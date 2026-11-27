#!/usr/bin/env bash
# Step 1 of the recovery: prove the target, write nothing.
#
#   ./precheck.sh --email owner@example.com --baseline-out ~/.wasit-secrets/baseline.json
#
# Prints the database identity, the gate decision, the masked account, how many
# accounts answer to that address, and how many sessions a rotation would revoke.
# Exits 2 — with no write of any kind — unless the target is a declared
# production database with exactly one SUPER_ADMIN at that address.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_email "$@"
shift 2

BASELINE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline-out)
      BASELINE="${2:-}"
      [[ -n "${BASELINE}" ]] || die "--baseline-out needs a path"
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

require_node
require_production_env
resolve_cli

if [[ -n "${BASELINE}" ]]; then
  BASELINE_DIR="$(dirname "${BASELINE}")"
  mkdir -p "${BASELINE_DIR}"
  chmod 700 "${BASELINE_DIR}"
  [[ -e "${BASELINE}" ]] && die "baseline already exists at ${BASELINE}; move it aside first"
  note "baseline will be written to ${BASELINE} (0600)"
  run_cli precheck --email "${EMAIL}" --baseline-out "${BASELINE}"
else
  run_cli precheck --email "${EMAIL}"
fi
