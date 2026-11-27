#!/usr/bin/env bash
# Builds a tarball an operator can carry to the production host.
#
#   ./package.sh --out /tmp/wasit-gm-recovery
#
# Contents: the self-contained CLI bundle (needs only Node 20+), these scripts,
# the runbook, and SHA256SUMS. Refuses to include anything that looks like a
# secret, so the package can never be the reason a password leaves its vault.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT="${2:-}"
      [[ -n "${OUT}" ]] || die "--out needs a directory"
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done
[[ -n "${OUT}" ]] || die "usage: $0 --out <directory>"

REPO="$(cd "${HERE}/../.." && pwd)"
BUNDLE="${REPO}/packages/server/dist-bundle/gm-access.cjs"
[[ -f "${BUNDLE}" ]] || die "build the CLI first: (cd packages/server && npm run build:prod)"

# Anything matching these names inside the repository would be a leaked secret.
FORBIDDEN='(^|/)(\.env|\.env\..*|.*\.pem|.*\.key|.*password.*\.txt)$'
if find "${REPO}/packages/server/dist-bundle" -maxdepth 1 -type f | grep -Eq "${FORBIDDEN}"; then
  die "refusing: the bundle directory contains a file that looks like a secret"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="wasit-gm-recovery-${STAMP}"
STAGE="${OUT}/${NAME}"
[[ -e "${STAGE}" ]] && die "${STAGE} already exists"

mkdir -p "${STAGE}/scripts" "${STAGE}/scripts/node_modules" "${STAGE}/docs"
chmod 700 "${STAGE}"
cp "${BUNDLE}" "${STAGE}/scripts/gm-access.cjs"

# argon2 is a native addon and the only dependency esbuild leaves external. Its
# prebuilt binaries ship with the package, so copying these three trees is enough
# for linux-x64 and linux-arm64 hosts.
for dep in argon2 @phc/format node-gyp-build; do
  src="${REPO}/node_modules/${dep}"
  [[ -d "${src}" ]] || die "missing ${dep} in node_modules; run npm install at the repository root"
  mkdir -p "$(dirname "${STAGE}/scripts/node_modules/${dep}")"
  cp -R "${src}" "${STAGE}/scripts/node_modules/${dep}"
done
for script in _common.sh check-runtime.sh precheck.sh rotate.sh verify.sh generate-password.sh login-check.sh package.sh; do
  cp "${HERE}/${script}" "${STAGE}/scripts/${script}"
done
chmod 755 "${STAGE}/scripts/"*.sh
cp "${REPO}/docs/GM-ACCESS-05.md" "${STAGE}/docs/" 2>/dev/null || true
cp "${REPO}/docs/GM-ACCESS-04.md" "${STAGE}/docs/" 2>/dev/null || true
cp "${REPO}/docs/GM-ACCESS-02.md" "${STAGE}/docs/" 2>/dev/null || true
cp "${HERE}/README.md" "${STAGE}/README.md"

# A last sweep: no secret-shaped file anywhere in the staged tree.
if find "${STAGE}" -type f | grep -Eq "${FORBIDDEN}"; then
  rm -rf "${STAGE}"
  die "refusing: a secret-shaped file reached the package; nothing was produced"
fi

(
  cd "${STAGE}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)
chmod 644 "${STAGE}/SHA256SUMS"

tar -C "${OUT}" -czf "${OUT}/${NAME}.tar.gz" "${NAME}"
chmod 644 "${OUT}/${NAME}.tar.gz"
rm -rf "${STAGE}"

note "package:  ${OUT}/${NAME}.tar.gz"
note "verify:   sha256sum -c SHA256SUMS  (inside the extracted directory)"
note "contains: gm-access.cjs bundle, argon2 prebuilds, scripts, runbook — no secrets"
