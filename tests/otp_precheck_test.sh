#!/usr/bin/env bash
# Prove the refusal happens BEFORE the OTP row is written and before any send.
# The row is inserted ahead of delivery in /register, so "no row" is exactly the
# assertion that the refusal returned early.
cd /home/elrio/hawkeye/backend
DB=storage/precheck-test.db
rm -f "$DB" "$DB-wal" "$DB-shm"

SMS_PROVIDER=console DB_PATH="$DB" PORT=8477 node src/server.js > /tmp/precheck_server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm"' EXIT
for i in $(seq 1 40); do
  curl -s -m 2 http://127.0.0.1:8477/api/health >/dev/null 2>&1 && break
  sleep 0.5
done

B=http://127.0.0.1:8477
PHONE=08031234567

# No sqlite3 CLI here; better-sqlite3 is already a dependency.
rows() { node -e "
const D=require('better-sqlite3');
try{const d=new D('$DB',{readonly:true});console.log(d.prepare('SELECT COUNT(*) c FROM otps').get().c)}catch(e){console.log('?')}"; }
clear_otps() { node -e "
const D=require('better-sqlite3');const d=new D('$DB');d.prepare('DELETE FROM otps').run()" 2>/dev/null; }
drop_pw() { node -e "
const D=require('better-sqlite3');const d=new D('$DB');d.prepare('UPDATE observers SET password_hash=NULL').run()" 2>/dev/null; }
set_pw() { node -e "
const D=require('better-sqlite3');const d=new D('$DB');
d.prepare(\"UPDATE observers SET password_hash='x', status='active'\").run()" 2>/dev/null; }
mk_observer() { node -e "
const D=require('better-sqlite3');const c=require('crypto');
const d=new D('$DB');
const {phoneHash}=require('./src/services/crypto.js');
" 2>/dev/null; }

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pass=0; fail=0
expect() { if [ "$2" = "$3" ]; then echo "  ok    $1 ($2)"; pass=$((pass+1)); else echo "  FAIL  $1: got '$2', want '$3'"; fail=$((fail+1)); fi; }

say "1. sign-up on a NEW number — a code must be sent"
clear_otps
CODE=$(curl -s -m 20 -o /tmp/r1.json -w '%{http_code}' -X POST "$B/api/observers/register" \
  -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\",\"intent\":\"signup\"}")
head -c 140 /tmp/r1.json; echo
expect "http" "$CODE" "200"
expect "otp row written" "$(rows)" "1"

say "2. give that account a password, then sign up AGAIN"
# The observer row only exists after a verify; create it directly for the test.
node -e "
const D=require('better-sqlite3');const d=new D('$DB');
const {phoneHash}=require('./src/services/crypto.js');
d.prepare('INSERT OR IGNORE INTO observers (phone_hash, public_key_jwk, device_id, created_at, status, password_hash) VALUES (?,?,?,?,?,?)')
 .run(phoneHash('$PHONE'),'{}','d',Date.now(),'active','pw');
" 2>/dev/null || node -e "
const D=require('better-sqlite3');const d=new D('$DB');
const r=d.prepare('SELECT phone_hash FROM otps LIMIT 1').get();
d.prepare('INSERT OR IGNORE INTO observers (phone_hash, public_key_jwk, device_id, created_at, status, password_hash) VALUES (?,?,?,?,?,?)')
 .run(r.phone_hash,'{}','d',Date.now(),'active','pw');"
clear_otps
CODE=$(curl -s -m 20 -o /tmp/r2.json -w '%{http_code}' -X POST "$B/api/observers/register" \
  -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\",\"intent\":\"signup\"}")
head -c 160 /tmp/r2.json; echo
expect "refused with 409" "$CODE" "409"
expect "NO otp row — nothing spent" "$(rows)" "0"

say "3. a RESET on the same number still sends (recovery must work)"
clear_otps
CODE=$(curl -s -m 20 -o /tmp/r3.json -w '%{http_code}' -X POST "$B/api/observers/register" \
  -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\"}")
expect "http" "$CODE" "200"
expect "otp row written" "$(rows)" "1"

say "4. sign-up on an account with NO password still sends (rescue path)"
drop_pw; clear_otps
CODE=$(curl -s -m 20 -o /tmp/r4.json -w '%{http_code}' -X POST "$B/api/observers/register" \
  -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\",\"intent\":\"signup\"}")
expect "http" "$CODE" "200"
expect "otp row written" "$(rows)" "1"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
