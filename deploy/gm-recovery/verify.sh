#!/usr/bin/env bash
# Step 3 of the recovery: prove the rotation did what it promised, and nothing else.
#
#   ./verify.sh --email owner@example.com --baseline ~/.wasit-secrets/baseline.json
#
# Read-only. Compares the live account with the baseline written by precheck:
# same database and account, argon2 hash, email verification and second factor
# unchanged, roles unchanged, every previous session revoked, one audit row
# written, and no secret in that row. Exits 2 if any check fails.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_email "$@"
shift 2

BASELINE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline)
      BASELINE="${2:-}"
      [[ -n "${BASELINE}" ]] || die "--baseline needs a path"
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "${BASELINE}" ]] || die "--baseline is required (written by precheck.sh)"
require_private_file "${BASELINE}" "baseline"
require_node
require_production_env
resolve_cli

run_cli verify --email "${EMAIL}" --baseline "${BASELINE}"
