#!/usr/bin/env bash
# Optional last check: prove the new password signs in, and that MFA is still asked.
#
#   ./login-check.sh --email owner@example.com --password-file ~/.wasit-secrets/gm.txt --api-url https://api.example.com
#
# Read-only from the database's point of view: it performs a real login against
# the running API. The password is read from the file into the request body and
# never printed; only status codes and booleans are shown.
#
# Expected: 200 with a session, or 200 with `mfaRequired: true` and a challenge.
# Anything else means the rotation did not deliver a usable credential.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_email "$@"
shift 2

PASSWORD_FILE=""
API_URL="${WASIT_API_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password-file)
      PASSWORD_FILE="${2:-}"
      [[ -n "${PASSWORD_FILE}" ]] || die "--password-file needs a path"
      shift 2
      ;;
    --api-url)
      API_URL="${2:-}"
      [[ -n "${API_URL}" ]] || die "--api-url needs a value"
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "${PASSWORD_FILE}" ]] || die "--password-file is required"
[[ -n "${API_URL}" ]] || die "--api-url (or WASIT_API_URL) is required"
require_private_file "${PASSWORD_FILE}" "password file"
require_node

node - "${EMAIL}" "${PASSWORD_FILE}" "${API_URL}" <<'NODE'
const { readFileSync } = require('node:fs');

const [email, passwordFile, apiUrl] = process.argv.slice(2);
const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');

(async () => {
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    /* a non-JSON body is reported by the status code alone */
  }
  const data = body?.data ?? {};
  const mfaRequired = data.mfaRequired === true || data.status === 'mfa_required';
  console.log(`status:      ${response.status}`);
  console.log(`mfaRequired: ${mfaRequired}`);
  console.log(`session:     ${response.headers.get('set-cookie') ? 'issued' : 'not issued'}`);

  if (response.status !== 200) {
    console.error('FAIL: the API did not accept the credential');
    process.exit(2);
  }
  if (mfaRequired) {
    console.log('PASS: password accepted, second factor still required (as it must be)');
    process.exit(0);
  }
  console.log('PASS: password accepted, no second factor on this account');
})().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(2);
});
NODE
