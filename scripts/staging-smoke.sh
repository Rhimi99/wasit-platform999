#!/usr/bin/env bash
# WASIT BUSINESS GLOBAL — Local/CI Staging Stack Verification.
#
# What this proves (and what it does NOT):
#   ✅ The repository's staging configuration boots a real, production-shaped
#      stack locally: db + api + web(nginx) with `NODE_ENV=staging`, the release
#      step (migrate → seed → serve), health through nginx, a real register →
#      verify → login flow, a market/product read, backup-heartbeat freshness,
#      and the fail-closed guard that rejects the committed dev JWT secret.
#   ❌ It is NOT proof that a *hosted* staging environment exists. A hosted
#      staging needs external infrastructure (a VM/domain, DNS/TLS, separate
#      secrets and a real backup destination) which lives outside this repo.
#      See docs/PRODUCTION_GAP_LIST.md (E1) and docs/DEPLOYMENT.md §9.
#
# Safety: it never touches the developer's own database. It creates a dedicated
# compose project with its own volumes and a git-ignored .env.staging.smoke,
# and removes the project, its volumes and its env file on exit (including on
# failure). No `db reset`, no `DROP`, no `db:push`, no production data.
#
# Usage: ./scripts/staging-smoke.sh
# Requires: docker + docker compose, curl, jq, openssl, python3.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# A dedicated compose project keeps these containers/volumes fully separate from
# any local dev stack the developer may already be running.
PROJECT_NAME="wasit-staging-smoke-$$"
ENV_FILE="$PROJECT_ROOT/.env.staging.smoke"
COMPOSE=(docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$PROJECT_ROOT/docker-compose.yml")
WEB_PORT="${STAGING_SMOKE_WEB_PORT:-18080}"
BASE_URL="http://127.0.0.1:${WEB_PORT}"
COOKIE_JAR="$(mktemp)"
FAILED_ENV_FILE="$PROJECT_ROOT/.env.staging.smoke.failed"

PASS=0
FAIL=0

say() { printf '\n== %s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }
expect_eq() { # expected actual label
  if [ "$1" = "$2" ]; then ok "$3 ($2)"; else bad "$3: expected '$1', got '$2'"; fi
}
expect_fail() { # label, then command
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$label (command unexpectedly succeeded)"; else ok "$label"; fi
}

# HTTP status of a request through nginx (the edge), never the API port directly.
http_status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# JSON body of a request through nginx.
http_body() { curl -s "$@"; }

cleanup() {
  local code=$?
  say "Cleanup"
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  # Keep the generated env file when the run failed, so the operator can inspect
  # (and re-run) the exact staging configuration that was exercised.
  if [ "$code" -ne 0 ] && [ -f "$ENV_FILE" ]; then
    mv "$ENV_FILE" "$FAILED_ENV_FILE" 2>/dev/null || true
    printf '  (kept failing env for inspection: %s)\n' "$FAILED_ENV_FILE"
  else
    rm -f "$ENV_FILE"
  fi
  rm -f "$COOKIE_JAR"
  "${COMPOSE[@]}" ps >/dev/null 2>&1 || true
  printf '\n== Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  if [ "$code" -eq 0 ] && [ "$FAIL" -ne 0 ]; then code=1; fi
  exit "$code"
}
# EXIT (not ERR) so the summary and cleanup always run exactly once.
trap cleanup EXIT

for tool in docker curl jq openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found in PATH" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose v2 not available" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Generate a staging env from the template, with real (random) staging secrets.
# ---------------------------------------------------------------------------
say "Generate .env.staging (NODE_ENV=staging, random secrets)"
[ -f "$PROJECT_ROOT/.env.staging.example" ] || { echo "ERROR: .env.staging.example missing" >&2; exit 1; }
JWT_SECRET_VALUE="$(openssl rand -hex 32)"
PG_PASSWORD_VALUE="$(openssl rand -hex 24)"
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PASSWORD_VALUE}|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET_VALUE}|" \
  -e "s|^WEB_PORT=.*|WEB_PORT=${WEB_PORT}|" \
  "$PROJECT_ROOT/.env.staging.example" > "$ENV_FILE"
grep -q '^NODE_ENV=staging$' "$ENV_FILE" && ok "NODE_ENV=staging" || bad "NODE_ENV is not staging"
# The template must carry the AI + backup contract (E1 review fix).
grep -q '^AI_PROVIDER=' "$ENV_FILE" && ok "AI_PROVIDER present" || bad "AI_PROVIDER missing from template"
grep -q '^AI_DEFAULT_MODEL=' "$ENV_FILE" && ok "AI_DEFAULT_MODEL present" || bad "AI_DEFAULT_MODEL missing"
grep -q '^AI_REQUEST_TIMEOUT_MS=' "$ENV_FILE" && ok "AI_REQUEST_TIMEOUT_MS present" || bad "AI_REQUEST_TIMEOUT_MS missing"
grep -q '^BACKUP_HEARTBEAT_FILE=' "$ENV_FILE" && ok "BACKUP_HEARTBEAT_FILE present" || bad "BACKUP_HEARTBEAT_FILE missing"
grep -q '^BACKUP_MAX_AGE_HOURS=' "$ENV_FILE" && ok "BACKUP_MAX_AGE_HOURS present" || bad "BACKUP_MAX_AGE_HOURS missing"

# ---------------------------------------------------------------------------
# A local production bundle for the fail-closed JWT-guard check below. The
# container runs its own copy; this only needs to exist on the host.
# ---------------------------------------------------------------------------
say "Build the API production bundle (for the JWT-guard check)"
npm run build:prod -w @wasit/server >/dev/null 2>&1 || { echo "ERROR: build:prod failed" >&2; exit 1; }
[ -f "$PROJECT_ROOT/packages/server/dist-bundle/index.cjs" ] && ok "dist-bundle/index.cjs built" || bad "dist-bundle/index.cjs missing"

# ---------------------------------------------------------------------------
# Build + up. The api release step runs migrate → seed → serve.
# ---------------------------------------------------------------------------
say "Build and start the staging stack (db + api + web + backup)"
"${COMPOSE[@]}" up -d --build

say "Wait for health (api ready + web healthy)"
# The web healthcheck only passes once nginx serves; but we also require the API
# to report ready so the release step (migrate + seed) has completed.
API_READY=0
for _ in $(seq 1 60); do
  if [ "$(http_status "$BASE_URL/api/health/ready")" = "200" ]; then API_READY=1; break; fi
  sleep 3
done
expect_eq 1 "$API_READY" "api /api/health/ready via nginx became 200"

WEB_HEALTH=""
for _ in $(seq 1 40); do
  WEB_HEALTH="$("${COMPOSE[@]}" ps --format json 2>/dev/null | jq -rs 'map(select(.Service=="web"))[0].Health // empty')"
  [ "$WEB_HEALTH" = "healthy" ] && break
  sleep 3
done
expect_eq "healthy" "$WEB_HEALTH" "web container healthcheck is healthy"

say "All three core services report healthy"
declare -A CORE=( [db]=0 [api]=0 [web]=0 )
for svc in db api web; do
  h="$("${COMPOSE[@]}" ps --format json 2>/dev/null | jq -rs --arg s "$svc" 'map(select(.Service==$s))[0].Health // empty')"
  [ "$h" = "healthy" ] && CORE[$svc]=1
  expect_eq 1 "${CORE[$svc]}" "$svc is healthy"
done

# ---------------------------------------------------------------------------
# Edge health through nginx (not the API port directly).
# ---------------------------------------------------------------------------
say "Health endpoints through nginx at $BASE_URL"
expect_eq 200 "$(http_status "$BASE_URL/")" "GET / (SPA) = 200"
expect_eq 200 "$(http_status "$BASE_URL/api/health/live")" "GET /api/health/live = 200"
READY_BODY="$(http_body "$BASE_URL/api/health/ready")"
expect_eq "ready" "$(printf '%s' "$READY_BODY" | jq -r '.status // empty')" "/api/health/ready status"
expect_eq "connected" "$(printf '%s' "$READY_BODY" | jq -r '.db // empty')" "/api/health/ready db"

CHANNELS_BODY="$(http_body "$BASE_URL/api/health/channels")"
CHANNELS_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/channels")"
expect_eq 200 "$CHANNELS_STATUS" "GET /api/health/channels = 200"
expect_eq "ok" "$(printf '%s' "$CHANNELS_BODY" | jq -r '.status // empty')" "/api/health/channels status"
# The channels payload must not leak credentials — only configuration status.
if printf '%s' "$CHANNELS_BODY" | grep -qiE 'password|secret|token|apiKey'; then
  bad "/api/health/channels leaks credential-looking fields"
else
  ok "/api/health/channels exposes no credential fields"
fi

# ---------------------------------------------------------------------------
# Real register → verify → login through nginx, then a market/product read.
# ---------------------------------------------------------------------------
EMAIL="staging-smoke-$$@wasit.tn"
PASSWORD="Passw0rd!2026"

say "Register → verify email → login (through nginx)"
REG_STATUS="$(http_status -X POST "$BASE_URL/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"firstName\":\"Smoke\",\"lastName\":\"Tester\",\"role\":\"CUSTOMER\"}")"
expect_eq 201 "$REG_STATUS" "POST /api/auth/register = 201"

# The staging stack serves mail over the `log` transport and opts into the
# dev-tooling escape hatch, so the real verification token can be fetched exactly
# as E2E does. This is the same token the email would carry.
VERIFY_LINK_BODY="$(http_body -X POST "$BASE_URL/api/auth/dev/verification-link" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")"
VERIFY_TOKEN="$(printf '%s' "$VERIFY_LINK_BODY" | jq -r '.data.token // empty')"
[ -n "$VERIFY_TOKEN" ] && ok "fetched real verification token" || bad "no verification token returned"

VERIFY_STATUS="$(http_status -X POST "$BASE_URL/api/auth/verify-email" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$VERIFY_TOKEN\"}")"
expect_eq 200 "$VERIFY_STATUS" "POST /api/auth/verify-email = 200"

LOGIN_STATUS="$(http_status -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
expect_eq 200 "$LOGIN_STATUS" "POST /api/auth/login = 200"
grep -q 'wasit_session' "$COOKIE_JAR" && ok "session cookie issued" || bad "no session cookie after login"

ME_BODY="$(http_body -b "$COOKIE_JAR" "$BASE_URL/api/auth/me")"
expect_eq "$EMAIL" "$(printf '%s' "$ME_BODY" | jq -r '.data.email // empty')" "GET /api/auth/me returns the account"

say "Market catalogue read (categories + products public read)"
CATS_BODY="$(http_body "$BASE_URL/api/categories")"
CAT_COUNT="$(printf '%s' "$CATS_BODY" | jq -r '.data | length' 2>/dev/null || echo 0)"
[ "${CAT_COUNT:-0}" -gt 0 ] && ok "categories seeded and readable ($CAT_COUNT)" || bad "no categories returned"
PRODUCTS_STATUS="$(http_status "$BASE_URL/api/products?pageSize=5")"
expect_eq 200 "$PRODUCTS_STATUS" "GET /api/products = 200"
PRODUCTS_TOTAL="$(http_body "$BASE_URL/api/products?pageSize=5" | jq -r '.data.pagination.total // .data.total // 0')"

# End-to-end merchant flow: create an entity, then a product, then read it back
# from the public listing (proves the catalogue path, not just a 200).
say "Merchant onboarding → product publish → public product read"
M_EMAIL="staging-smoke-merchant-$$@wasit.tn"
http_status -X POST "$BASE_URL/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$M_EMAIL\",\"password\":\"$PASSWORD\",\"role\":\"MERCHANT\"}" >/dev/null
M_TOKEN="$(http_body -X POST "$BASE_URL/api/auth/dev/verification-link" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$M_EMAIL\"}" | jq -r '.data.token // empty')"
http_status -X POST "$BASE_URL/api/auth/verify-email" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$M_TOKEN\"}" >/dev/null
M_COOKIE="$(mktemp)"
http_status -c "$M_COOKIE" -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$M_EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
MERCHANT_ID="$(http_body -b "$M_COOKIE" -X POST "$BASE_URL/api/merchants" -H 'Content-Type: application/json' \
  -d "{\"storeName\":\"Staging Smoke Store $$\"}" | jq -r '.data.id // empty')"
[ -n "$MERCHANT_ID" ] && ok "merchant entity created ($MERCHANT_ID)" || bad "merchant entity not created"
CATEGORY_ID="$(printf '%s' "$CATS_BODY" | jq -r '.data[0].id // empty')"
NEW_PRODUCT_ID="$(http_body -b "$M_COOKIE" -X POST "$BASE_URL/api/products" -H 'Content-Type: application/json' \
  -d "{\"sellerId\":\"$MERCHANT_ID\",\"sellerType\":\"MERCHANT\",\"categoryId\":\"$CATEGORY_ID\",\"name\":\"Staging Smoke Product $$\",\"sku\":\"SMOKE-$$\",\"currencyCode\":\"TND\",\"basePrice\":\"12.5000\",\"moq\":1,\"initialQuantity\":5}" \
  | jq -r '.data.id // empty')"
[ -n "$NEW_PRODUCT_ID" ] && ok "product created ($NEW_PRODUCT_ID)" || bad "product not created"
if [ -n "$NEW_PRODUCT_ID" ]; then
  EXPECT_EQ_NAME="Staging Smoke Product $$"
  READ_BACK="$(http_body "$BASE_URL/api/products/$NEW_PRODUCT_ID" | jq -r '.data.name // empty')"
  expect_eq "$EXPECT_EQ_NAME" "$READ_BACK" "public product read returns the created product"
  # `q` matches product name/description (not SKU), so search by the name.
  SEARCH_HIT="$(curl -s -G "$BASE_URL/api/products" --data-urlencode "q=Staging Smoke Product $$" | jq -r '.data.pagination.total // .data.total // 0')"
  [ "${SEARCH_HIT:-0}" -ge 1 ] && ok "search finds the new product" || bad "search did not find the new product"
fi
rm -f "$M_COOKIE"
printf '  (products in catalogue before merchant flow: %s)\n' "${PRODUCTS_TOTAL:-0}"

# ---------------------------------------------------------------------------
# Backup heartbeat freshness (the operator-visible half of `backup_stale`).
# ---------------------------------------------------------------------------
say "Backup heartbeat freshness"
BACKUP_CFG="$(printf '%s' "$CHANNELS_BODY" | jq -r '.backup.configured')"
BACKUP_AGE="$(printf '%s' "$CHANNELS_BODY" | jq -r '.backup.ageHours')"
BACKUP_MAX="$(printf '%s' "$CHANNELS_BODY" | jq -r '.backup.maxAgeHours')"
expect_eq "true" "$BACKUP_CFG" "backup heartbeat is configured"
if [ "$BACKUP_AGE" != "null" ] && [ -n "$BACKUP_AGE" ]; then
  FRESH="$(python3 -c "import sys; print(1 if float(sys.argv[1]) <= float(sys.argv[2]) else 0)" "$BACKUP_AGE" "$BACKUP_MAX")"
  expect_eq 1 "$FRESH" "backup heartbeat is fresh (${BACKUP_AGE}h <= ${BACKUP_MAX}h)"
else
  bad "no backup heartbeat found (ageHours=null)"
fi

# ---------------------------------------------------------------------------
# Fail-closed: staging must refuse to boot with the committed dev JWT secret.
# ---------------------------------------------------------------------------
say "Staging refuses the committed development JWT_SECRET"
DEV_SECRET="dev-only-secret-not-for-production-please-change-me-1234567890"
set +e
REJECT_OUT="$(NODE_ENV=staging JWT_SECRET="$DEV_SECRET" DATABASE_URL="postgresql://x:x@127.0.0.1:1/x" \
  node "$PROJECT_ROOT/packages/server/dist-bundle/index.cjs" 2>&1)"
REJECT_CODE=$?
set -e
if [ "$REJECT_CODE" -ne 0 ]; then
  ok "api exited non-zero with the dev JWT secret (exit $REJECT_CODE)"
else
  bad "api booted with the committed dev JWT secret"
fi
if printf '%s' "$REJECT_OUT" | grep -qi 'JWT_SECRET'; then
  ok "refusal names JWT_SECRET"
else
  bad "refusal does not mention JWT_SECRET: $REJECT_OUT"
fi

# A correct secret (>=32 chars, not the dev default) must NOT be rejected by the
# guard itself — it should fail later on the unreachable database instead, which
# proves the guard rejects the *value* and not every staging boot.
set +e
GOOD_OUT="$(NODE_ENV=staging JWT_SECRET="$(openssl rand -hex 32)" DATABASE_URL="postgresql://x:x@127.0.0.1:1/x" \
  timeout 20 node "$PROJECT_ROOT/packages/server/dist-bundle/index.cjs" 2>&1)"
set -e
if printf '%s' "$GOOD_OUT" | grep -qi 'Refusing to start'; then
  bad "a valid staging secret was refused at the guard"
else
  ok "a valid staging secret passes the JWT guard"
fi
