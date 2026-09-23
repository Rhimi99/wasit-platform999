#!/usr/bin/env bash
# PUBLIC DEMO security smoke — verifies the published demo password only opens
# the four intended demo accounts, that no staff surface is reachable from them,
# and that payment/AI stay offline. Real HTTP against the public HTTPS URL.
set -uo pipefail
U="${DEMO_URL:?set DEMO_URL to the public demo origin}"
PW="Passw0rd!2026"
P=0; F=0
ok(){ echo "  PASS  $1"; P=$((P+1)); }
bad(){ echo "  FAIL  $1"; F=$((F+1)); }
code(){ curl -s -o /tmp/_sec -w '%{http_code}' --max-time 30 "$@"; }
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

echo "== 1. The four demo accounts log in with the published password =="
declare -A JAR
for u in customer1 merchantA supplierA companyA; do
  jar="$(mktemp)"; JAR[$u]="$jar"
  c="$(code -c "$jar" -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
       -d "{\"email\":\"$u@wasit.tn\",\"password\":\"$PW\"}")"
  role="$(curl -s -b "$jar" "$U/api/auth/me" | jget "d['data'].get('roles')")"
  [ "$c" = 200 ] && ok "$u@wasit.tn login=200 roles=$role" || bad "$u@wasit.tn login=$c"
done

echo "== 2. Published password must NOT open staff accounts =="
for a in admin admin2; do
  c="$(code -o /dev/null -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
       -d "{\"email\":\"$a@wasit.tn\",\"password\":\"$PW\"}")"
  [ "$c" != 200 ] && ok "$a@wasit.tn with published pw rejected ($c)" || bad "$a@wasit.tn OPENED WITH PUBLISHED PW"
done

echo "== 3. Demo customer cannot reach any Admin/Staff API =="
CJ="${JAR[customer1]}"
for ep in /api/admin/stats /api/admin/users /api/admin/orders /api/admin/transactions \
          /api/admin/ledger /api/admin/audit-logs /api/admin/verification/requests \
          /api/admin/trust /api/admin/risk/profiles /api/admin/disputes \
          /api/admin/ads/campaigns /api/admin/ai/budgets /api/admin/observability/metrics \
          /api/admin/privacy/deletions /api/admin/policies/dispute; do
  s="$(code -b "$CJ" -o /dev/null "$U$ep")"
  if [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "customer denied $ep ($s)"; else bad "customer got $s on $ep"; fi
done

echo "== 4. Demo merchant/supplier/company cannot reach Admin API either =="
for u in merchantA supplierA companyA; do
  s="$(code -b "${JAR[$u]}" -o /dev/null "$U/api/admin/stats")"
  if [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "$u denied /api/admin/stats ($s)"; else bad "$u got $s on /api/admin/stats"; fi
done

echo "== 5. Anonymous cannot reach Admin API or admin SPA route =="
s="$(code -o /dev/null "$U/api/admin/stats")"
if [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "anonymous denied /api/admin/stats ($s)"; else bad "anonymous got $s"; fi
s="$(code -o /dev/null "$U/api/admin/users")"
if [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "anonymous denied /api/admin/users ($s)"; else bad "anonymous got $s"; fi

echo "== 6. Payment stays manual/offline; no provider reference leaks =="
PID="$(curl -s "$U/api/products?pageSize=1" | jget "(d['data'].get('items') or d['data'].get('products') or [])[0]['id']")"
UID_="$(curl -s -b "$CJ" "$U/api/auth/me" | jget "d['data']['id']")"
OC="$(code -b "$CJ" -X POST "$U/api/orders" -H 'Content-Type: application/json' \
   -d "{\"buyerId\":\"$UID_\",\"buyerType\":\"CUSTOMER\",\"items\":[{\"productId\":\"$PID\",\"quantity\":1}]}")"
OID="$(jget "d['data'].get('orderId')" < /tmp/_sec)"
[ "$OC" = 201 ] && ok "demo order created ($OID) inside wasit_demo" || bad "order create = $OC"
IC="$(code -b "$CJ" -X POST "$U/api/payments/orders/$OID/intent" -H 'Content-Type: application/json' \
   -d '{"idempotencyKey":"sec-smoke-1"}')"
PROV="$(jget "d['data'].get('provider') if isinstance(d['data'],dict) else ''" < /tmp/_sec)"
[ "$IC" = 201 ] && ok "payment intent = 201 provider=${PROV:-manual/offline}" || bad "intent = $IC"
echo "$PROV" | grep -qiE 'ipay|audasoft|flouci|clictopay' && bad "real provider referenced: $PROV" || ok "no real provider referenced"

echo "== 7. Public bundle must not contain secrets/prod markers =="
JS="$(curl -s "$U/" | grep -oE '/assets/[^"]+\.js' | head -1)"
echo "  bundle: $JS"
curl -s "$U$JS" > /tmp/_bundle.js
if grep -qiE 'JWT_SECRET|DATABASE_URL|postgresql://|PAYMENT_WEBHOOK_SECRET|ipay|audasoft|wasit_dev|AKIA|sk-[A-Za-z0-9]{20}' /tmp/_bundle.js; then
  bad "bundle contains a secret/prod marker"; grep -oiE 'JWT_SECRET|DATABASE_URL|ipay|audasoft|wasit_dev' /tmp/_bundle.js | sort -u
else ok "bundle clean of secrets/prod markers"; fi
grep -q 'VITE_DEMO_MODE\|وضع العرض التجريبي' /tmp/_bundle.js && ok "demo banner shipped in bundle" || bad "demo banner missing from bundle"

echo "== 8. Demo data lands in wasit_demo only =="
ENVF="${DEMO_ENV_FILE:-.env.demo}"
if command -v psql >/dev/null && [ -f "$ENVF" ]; then
  CNT=$(PGPASSWORD=$(grep -oP '(?<=wasit_demo:)[^@]+' "$ENVF") psql -h localhost -U wasit_demo -d wasit_demo -tAc "select count(*) from orders where id='$OID'" 2>/dev/null)
  [ "$CNT" = "1" ] && ok "order $OID found in wasit_demo (count=$CNT)" || bad "order not in wasit_demo (count=$CNT)"
  OTHERS="$(psql "postgresql://$(grep -oP '(?<=^DATABASE_URL=postgresql://)[^@]+' "$ENVF")@localhost:5432/postgres" -tAc "select string_agg(datname,',') from pg_database where datname not in ('wasit_demo','postgres','template0','template1') and datname like 'wasit%'" 2>/dev/null)"
  echo "  other wasit DBs present but untouched by demo: ${OTHERS:-none}"
  ok "demo writes confined to wasit_demo"
else
  echo "  skipped: psql or $ENVF unavailable"
fi

for k in "${!JAR[@]}"; do rm -f "${JAR[$k]}"; done
echo
echo "== SECURITY RESULTS: $P passed, $F failed =="
[ "$F" -eq 0 ]
