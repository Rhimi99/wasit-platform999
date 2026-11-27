#!/usr/bin/env bash
# Shared helpers for the GM recovery package.
#
# Contract: every script in this directory refuses to run unless the deployment
# declares itself production. The CLI enforces the same rule against the live
# server; this layer only fails earlier and with a clearer message.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  printf 'REFUSED: %s\n' "$*" >&2
  exit 2
}

note() {
  printf '%s\n' "$*"
}

# Resolves how to invoke the CLI, in order of preference:
#   1. GM_ACCESS_CLI   — explicit command, e.g. "node /opt/wasit/gm-access.cjs"
#   2. ./gm-access.cjs — the bundle shipped next to these scripts
#   3. packages/server — a checkout, run through npm
resolve_cli() {
  if [[ -n "${GM_ACCESS_CLI:-}" ]]; then
    read -r -a CLI <<<"${GM_ACCESS_CLI}"
  elif [[ -f "${HERE}/gm-access.cjs" ]]; then
    CLI=(node "${HERE}/gm-access.cjs")
  elif [[ -f "${HERE}/../../packages/server/package.json" ]]; then
    CLI=(npm --prefix "${HERE}/../../packages/server" run --silent gm:access --)
  else
    die "gm:access not found. Put gm-access.cjs next to these scripts or set GM_ACCESS_CLI."
  fi
  command -v "${CLI[0]}" >/dev/null 2>&1 || die "cannot execute '${CLI[0]}' (is Node.js installed?)"
}

run_cli() {
  "${CLI[@]}" "$@"
}

require_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${major}" -ge 20 ]] || die "Node.js 20+ required, found $(node -v)"
}

# The three signals the guard needs. Checked here so the operator sees a clear
# message before a connection is attempted; the CLI checks them again for real.
require_production_env() {
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set in this shell"
  [[ "${NODE_ENV:-}" == "production" ]] || die "NODE_ENV must be 'production' (currently '${NODE_ENV:-unset}')"
  [[ -n "${WASIT_PRODUCTION_DB_NAME:-}" ]] || die "WASIT_PRODUCTION_DB_NAME must name this deployment's production database"
  case "${WASIT_PRODUCTION_DB_NAME}" in
    *[!a-zA-Z0-9_-]*) die "WASIT_PRODUCTION_DB_NAME contains unexpected characters" ;;
  esac
  local lowered="${WASIT_PRODUCTION_DB_NAME,,}"
  case "${lowered}" in
    postgres | template* | wasit_dev | wasit_staging | wasit_test | wasit_demo | *_test | *_demo | *_dev | *_staging | _restore* | _drill*)
      die "WASIT_PRODUCTION_DB_NAME='${WASIT_PRODUCTION_DB_NAME}' is a test, demo, development, staging or system database"
      ;;
  esac
}

require_email() {
  [[ $# -ge 1 && -n "$1" ]] || die "usage: $0 --email <address> [options]"
  if [[ "$1" != "--email" ]]; then
    die "the first argument must be --email"
  fi
  [[ -n "${2:-}" ]] || die "--email needs a value"
  EMAIL="$2"
  [[ "${EMAIL}" == *@*.* ]] || die "'${EMAIL}' does not look like an address"
}

# A baseline is written by precheck and read by verify. It holds no secret, but
# it names the account, so it stays owner-only.
require_private_file() {
  local path="$1" label="$2"
  [[ -f "${path}" ]] || die "${label} not found: ${path}"
  local mode
  mode="$(stat -c '%a' "${path}")"
  [[ "${mode}" == "600" || "${mode}" == "400" ]] || die "${label} must be mode 600 (found ${mode}): chmod 600 ${path}"
}
