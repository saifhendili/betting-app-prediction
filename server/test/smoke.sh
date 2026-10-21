#!/usr/bin/env bash
# End-to-end smoke test against the mocked upstream — no API quota consumed.
#   ./test/smoke.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=5055
S="http://localhost:$PORT"
LOG=$(mktemp)

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT

node -e "const m=require('mongoose');m.connect('mongodb://127.0.0.1:27017/betting_mocktest').then(async()=>{await m.connection.dropDatabase();await m.disconnect()}).catch(()=>{})" 2>/dev/null

node --import ./test/mock-upstream.mjs src/index.js > "$LOG" 2>&1 &
SRV=$!

for i in $(seq 1 30); do
  curl -sf "$S/api/health" > /dev/null 2>&1 && break
  sleep 0.5
done

PASS=0; FAIL=0
check() {
  local name="$1" url="$2" pred="$3" out
  out=$(curl -s "$S$url" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('BADJSON'); raise SystemExit
print('OK' if ($pred) else 'FAIL')
" 2>/dev/null)
  if [ "$out" = "OK" ]; then PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$name"
  else FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s (%s)\n" "$name" "${out:-no response}"; fi
}

echo "── listings"
check "games today"           "/api/games?sport=football&window=today" "d['counts']['total']>0"
check "live window is live"   "/api/games?sport=football&window=live"  "all(g['state']=='live' for g in d['games'])"
check "1h window bounded"     "/api/games?sport=football&window=1h"    "all(g['startsInMinutes']<=60 for g in d['games'])"
check "3h window bounded"     "/api/games?sport=football&window=3h"    "all(g['startsInMinutes']<=180 for g in d['games'])"
check "sport=all merges 3"    "/api/games?sport=all&window=today"      "len({g['sport'] for g in d['games']})==3"
check "league tier present"   "/api/games?sport=football&window=today" "all('tier' in g['league'] for g in d['games'])"

echo "── predictions × sport × risk"
for SP in football basketball hockey; do
  for R in easy mid aggressive; do
    check "$SP/$R" "/api/predictions/$SP/101?risk=$R" \
      "len(d['picks'])>0 and 0<d['confidence']<=96 and d['risk']=='$R'"
  done
done

echo "── invariants"
check "no contradictory picks" "/api/predictions/hockey/101?risk=aggressive" "len({p['conflictKey'] for p in d['picks']})==len(d['picks'])"
check "probabilities in (0,1)" "/api/predictions/football/101?risk=mid"      "all(0<p['probability']<1 for p in d['picks'])"
check "fair odds = 1/p"        "/api/predictions/football/101?risk=mid"      "all(abs(p['fairOdds']-1/p['probability'])<0.02 for p in d['picks'])"
check "1X2 sums to 1"          "/api/predictions/football/101?risk=mid"      "abs(sum(d['model']['outcome'].values())-1)<0.01"
check "no settled markets"     "/api/predictions/football/999?risk=easy"     "all(p['probability']<0.985 for p in d['picks'])"

echo "── in-play rebasing"
check "football 63' → 27 left"  "/api/predictions/football/999?risk=mid"   "d['model']['live']['remainingMinutes']==27"
check "basketball Q3 → 18 left" "/api/predictions/basketball/999?risk=mid" "d['model']['live']['remainingMinutes']==18"
check "hockey P2 → 30 left"     "/api/predictions/hockey/999?risk=mid"     "d['model']['live']['remainingMinutes']==30"

echo "── endpoints"
check "top picks distinct"  "/api/predictions/top?sport=football&window=12h&count=4" "len({p['gameId'] for p in d['predictions']})==len(d['predictions'])"
check "risk profiles"       "/api/predictions/profiles" "len(d['profiles'])==3"
check "meta"                "/api/health/meta"          "len(d['sports'])==3 and len(d['windows'])==9"
check "key dashboard"       "/api/health/keys"          "d['sports']['configured']==3 and d['gemini']['configured']==2"

echo "── settings"
check "settings readable"   "/api/settings" "'gemini' in d and 'sports' in d and 'persistence' in d"
check "keys reported masked" "/api/settings" "all('…' in k or '***' in k for k in d['gemini']['masked']+d['sports']['masked'])"
check "env keys detected"    "/api/settings" "d['gemini']['count']==2 and d['sports']['count']==3"

# PUT/validation checks need a body, so they are done inline
put() {
  local name="$1" body="$2" pred="$3" out
  out=$(curl -s -X PUT "$S/api/settings" -H 'content-type: application/json' -d "$body" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('BADJSON'); raise SystemExit
print('OK' if ($pred) else 'FAIL')
" 2>/dev/null)
  if [ "$out" = "OK" ]; then PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$name"
  else FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s (%s)\n" "$name" "${out:-no response}"; fi
}
put "save gemini keys"      '{"geminiKeys":["k1aaaaaaaaaa","k2bbbbbbbbbb","k3cccccccccc"]}' "d['settings']['gemini']['count']==3 and d['settings']['gemini']['source']=='settings'"
put "sports keys untouched" '{"geminiModel":"gemini-2.5-flash"}' "d['settings']['sports']['count']==3"
put "partial save is safe"  '{"sportsKeys":["s1aaaaaaaaaa"]}' "d['settings']['gemini']['count']==3 and d['settings']['sports']['count']==1"
put "reject bad type"       '{"geminiKeys":123}' "'error' in d"
put "reject empty patch"    '{}' "'error' in d"
put "clear keys"            '{"geminiKeys":[],"sportsKeys":[]}' "d['settings']['gemini']['source']=='env'"

echo "── admin token gate (hosting)"
# Run a second instance with ADMIN_TOKEN set and check writes are refused.
GATE_PORT=5057
ADMIN_TOKEN=smoketoken123 PORT=$GATE_PORT node --import ./test/mock-upstream.mjs src/index.js > /dev/null 2>&1 &
GATE=$!
for i in $(seq 1 30); do curl -sf "http://localhost:$GATE_PORT/api/health" > /dev/null 2>&1 && break; sleep 0.5; done
gate() {
  local name="$1" expect="$2" code
  shift 2
  code=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$code" = "$expect" ]; then PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$name"
  else FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s (got %s, want %s)\n" "$name" "$code" "$expect"; fi
}
G="http://localhost:$GATE_PORT"
gate "GET settings stays open"   200 "$G/api/settings"
gate "PUT without token → 401"   401 -X PUT "$G/api/settings" -H 'content-type: application/json' -d '{"geminiKeys":["x"]}'
gate "PUT wrong token → 401"     401 -X PUT "$G/api/settings" -H 'content-type: application/json' -H 'x-admin-token: nope' -d '{"geminiKeys":["x"]}'
gate "PUT right token → 200"     200 -X PUT "$G/api/settings" -H 'content-type: application/json' -H 'x-admin-token: smoketoken123' -d '{"geminiModel":"gemini-2.5-flash"}'
gate "POST test without → 401"   401 -X POST "$G/api/settings/test" -H 'content-type: application/json' -d '{}'
gate "games stay public"         200 "$G/api/games?sport=football&window=today&limit=2"
kill "$GATE" 2>/dev/null

echo "── error handling"
check "unknown sport 400"   "/api/predictions/cricket/1" "'error' in d"
check "bad risk falls back" "/api/predictions/football/101?risk=banana" "d['risk']=='mid'"

echo
printf "\033[1m%d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
