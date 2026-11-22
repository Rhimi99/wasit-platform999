#!/usr/bin/env bash
# PUBLIC DEMO security smoke — real HTTP against the public HTTPS origin.
#
# Since DEMO-SEC-03 every demo account carries its own random password, so this
# script reads credentials from the environment (or the git-ignored `.env.demo`)
# and never prints, echoes or logs them. It asserts:
#   1. each demo account opens with its own password, and only that one;
#   2. staff accounts open only with the staff password;
#   3. no demo role reaches a staff/admin API;
#   4. anonymous callers cannot mint a session (demo-session / demo-audit-session);
#   5. payments stay manual/offline and the public bundle is secret-free;
#   6. demo writes land in the demo database only.
#
# Usage: DEMO_URL=https://… bash scripts/demo-security-smoke.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
U="${DEMO_URL:?set DEMO_URL to the public demo origin}"
P=0; F=0
ok(){ echo "  PASS  $1"; P=$((P+1)); }
bad(){ echo "  FAIL  $1"; F=$((F+1)); }
code(){ curl -s -o /tmp/_sec -w '%{http_code}' --max-time 30 "$@"; }
jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

pw() { node -e "import('./scripts/lib/demo-credentials.mjs').then(m=>process.stdout.write(m.demoPasswordFor(process.argv[1]))).catch(()=>process.exit(1))" "$1"; }

declare -A EMAIL=([customer]=customer1@wasit.tn [merchant]=merchanta@wasit.tn [supplier]=suppliera@wasit.tn [company]=companya@wasit.tn)
declare -A ROLE=([customer]=CUSTOMER [merchant]=MERCHANT [supplier]=SUPPLIER [company]=COMPANY)
declare -A JAR

echo "== 1. Each demo account opens with its own password =="
for k in customer merchant supplier company; do
  jar="$(mktemp)"; JAR[$k]="$jar"
  p="$(pw "${EMAIL[$k]}")" || { bad "${EMAIL[$k]}: no credential configured"; continue; }
  c="$(code -c "$jar" -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
       -d "{\"email\":\"${EMAIL[$k]}\",\"password\":\"$p\"}")"
  roles="$(curl -s -b "$jar" "$U/api/auth/me" | jget "','.join(d['data'].get('roles') or [])")"
  if [ "$c" = 200 ] && echo "$roles" | grep -q "${ROLE[$k]}"; then
    ok "${EMAIL[$k]} login=200 roles=$roles"
  else
    bad "${EMAIL[$k]} login=$c roles=${roles:-none}"
  fi
done

echo "== 2. A demo password is not a master key =="
cp_="$(pw customer1@wasit.tn)" || cp_=""
if [ -n "$cp_" ]; then
  for k in merchant supplier company; do
    c="$(code -o /dev/null -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
         -d "{\"email\":\"${EMAIL[$k]}\",\"password\":\"$cp_\"}")"
    [ "$c" != 200 ] && ok "${EMAIL[$k]} rejects customer1 password ($c)" || bad "${EMAIL[$k]} OPENED WITH ANOTHER ACCOUNT'S PASSWORD"
  done
  for a in admin admin2; do
    c="$(code -o /dev/null -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
         -d "{\"email\":\"$a@wasit.tn\",\"password\":\"$cp_\"}")"
    [ "$c" != 200 ] && ok "$a@wasit.tn rejects demo password ($c)" || bad "$a@wasit.tn OPENED WITH A DEMO PASSWORD"
  done
fi

echo "== 3. Staff password opens staff only =="
sp="$(pw admin@wasit.tn)" || sp=""
if [ -n "$sp" ]; then
  for a in admin admin2; do
    jar="$(mktemp)"
    ap="$(pw "$a@wasit.tn")" || { bad "$a@wasit.tn: no credential configured"; rm -f "$jar"; continue; }
    c="$(code -c "$jar" -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
         -d "{\"email\":\"$a@wasit.tn\",\"password\":\"$ap\"}")"
    s="$(code -b "$jar" -o /dev/null "$U/api/admin/stats")"
    if [ "$c" = 200 ] && [ "$s" = 200 ]; then ok "$a@wasit.tn login=200 admin/stats=200"; else bad "$a@wasit.tn login=$c admin/stats=$s"; fi
    rm -f "$jar"
  done
  c="$(code -o /dev/null -X POST "$U/api/auth/login" -H 'Content-Type: application/json' \
       -d "{\"email\":\"customer1@wasit.tn\",\"password\":\"$sp\"}")"
  [ "$c" != 200 ] && ok "customer1 rejects staff password ($c)" || bad "customer1 OPENED WITH STAFF PASSWORD"
else
  echo "  SKIP  staff credential not configured"
fi

echo "== 4. No demo role reaches a staff/admin API =="
for k in customer merchant supplier company; do
  for ep in /api/admin/stats /api/admin/users /api/admin/orders /api/admin/audit-logs \
            /api/admin/verification/requests /api/admin/trust /api/admin/risk/profiles \
            /api/admin/disputes /api/admin/ai/budgets /api/admin/privacy/deletions \
            /api/admin/policies/dispute /api/admin/observability/logs; do
    s="$(code -b "${JAR[$k]}" -o /dev/null "$U$ep")"
    if [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "$k denied $ep ($s)"; else bad "$k got $s on $ep"; fi
  done
done

echo "== 5. Anonymous cannot mint a session or reach admin =="
for ep in /api/admin/stats /api/admin/users; do
  s="$(code -o /dev/null "$U$ep")"
  if [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "anonymous denied $ep ($s)"; else bad "anonymous got $s on $ep"; fi
done
s="$(code -o /dev/null -X POST "$U/api/auth/demo-session")"
if [ "$s" = 404 ] || [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "demo-session closed to visitors ($s)"; else bad "demo-session answered $s"; fi
s="$(code -o /dev/null -X POST "$U/api/auth/demo-audit-session" -H 'Content-Type: application/json' -d '{"persona":"super_admin"}')"
if [ "$s" = 404 ] || [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "demo-audit-session closed to visitors ($s)"; else bad "demo-audit-session answered $s"; fi
s="$(code -b "${JAR[customer]}" -o /dev/null -X POST "$U/api/auth/demo-audit-session" -H 'Content-Type: application/json' -d '{"persona":"super_admin"}')"
if [ "$s" = 404 ] || [ "$s" = 401 ] || [ "$s" = 403 ]; then ok "demo-audit-session refuses a customer ($s)"; else bad "customer minted a persona session ($s)"; fi

echo "== 6. Cross-origin requests get no CORS grant =="
H="$(curl -s -D - -o /dev/null -X OPTIONS "$U/api/auth/login" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | tr -d '\r')"
if echo "$H" | grep -qi '^access-control-allow-origin'; then bad "foreign origin received ACAO"; else ok "no ACAO for a foreign origin"; fi

echo "== 7. Payment stays manual/offline =="
PID="$(curl -s "$U/api/products?pageSize=1" | jget "(d['data'].get('items') or d['data'].get('products') or [])[0]['id']")"
UID_="$(curl -s -b "${JAR[customer]}" "$U/api/auth/me" | jget "d['data']['id']")"
OC="$(code -b "${JAR[customer]}" -X POST "$U/api/orders" -H "Origin: $U" -H 'Content-Type: application/json' \
   -d "{\"buyerId\":\"$UID_\",\"buyerType\":\"CUSTOMER\",\"items\":[{\"productId\":\"$PID\",\"quantity\":1}]}")"
OID="$(jget "d['data'].get('orderId')" < /tmp/_sec)"
[ "$OC" = 201 ] && ok "demo order created ($OID)" || bad "order create = $OC"
IC="$(code -b "${JAR[customer]}" -X POST "$U/api/payments/orders/$OID/intent" -H "Origin: $U" -H 'Content-Type: application/json' \
   -d "{\"idempotencyKey\":\"sec-smoke-$(date +%s)\"}")"
PROV="$(jget "d['data'].get('provider') if isinstance(d['data'],dict) else ''" < /tmp/_sec)"
[ "$IC" = 201 ] && ok "payment intent = 201 provider=${PROV:-manual}" || bad "intent = $IC"
if echo "$PROV" | grep -qiE 'ipay|audasoft|flouci|clictopay|stripe|paypal'; then bad "real provider referenced: $PROV"; else ok "no real provider referenced"; fi

echo "== 8. Public bundle is secret-free and shows the demo banner =="
JS="$(curl -s "$U/" | grep -oE '/assets/[^"]+\.js' | head -1)"
curl -s "$U$JS" > /tmp/_bundle.js
if grep -qiE 'JWT_SECRET|DATABASE_URL|postgresql://|PAYMENT_WEBHOOK_SECRET|ipay|audasoft|wasit_dev|wasit_demo|AKIA|sk-[A-Za-z0-9]{20}' /tmp/_bundle.js; then
  bad "bundle contains a secret or prod marker"
  grep -oiE 'JWT_SECRET|DATABASE_URL|ipay|audasoft|wasit_dev|wasit_demo' /tmp/_bundle.js | sort -u
else ok "bundle clean of secrets/prod markers"; fi
grep -q 'بيانات تجريبية فقط' /tmp/_bundle.js && ok "demo banner shipped" || bad "demo banner missing"

echo "== 9. Writes land in the demo database only =="
DBURL="$(grep '^DATABASE_URL=' .env.demo 2>/dev/null | cut -d= -f2-)"
if [ -n "$DBURL" ] && command -v psql >/dev/null; then
  case "$DBURL" in
    */wasit_demo) ok "DATABASE_URL targets wasit_demo" ;;
    *) bad "DATABASE_URL is not the demo database" ;;
  esac
  CNT="$(psql "$DBURL" -tAc "select count(*) from orders where id='$OID'" 2>/dev/null)"
  [ "$CNT" = "1" ] && ok "order $OID is in the demo database" || bad "order not found in the demo database"
  SETTLED="$(psql "$DBURL" -tAc "select count(*) from transaction_ledger where status='SETTLED'" 2>/dev/null)"
  [ "${SETTLED:-0}" = "0" ] && ok "no SETTLED ledger rows (no real settlement)" || bad "$SETTLED SETTLED ledger rows"
else
  echo "  SKIP  psql or .env.demo unavailable"
fi

for k in "${!JAR[@]}"; do rm -f "${JAR[$k]}"; done
rm -f /tmp/_sec /tmp/_bundle.js
echo
echo "== SECURITY RESULTS: $P passed, $F failed =="
[ "$F" -eq 0 ]
