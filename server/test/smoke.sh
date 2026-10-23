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

check "stale pre-match price not bettable" "/api/predictions/football/999?risk=mid" "d['dataSource']['marketKind']=='stale-prematch' and all(p['marketOdds'] is None and p.get('evModel') is None for p in d['picks'])"

echo "── endpoints"
check "top picks distinct"  "/api/predictions/top?sport=football&window=12h&count=4" "len({p['gameId'] for p in d['predictions']})==len(d['predictions'])"
check "risk profiles"       "/api/predictions/profiles" "len(d['profiles'])==3"
check "meta"                "/api/health/meta"          "len(d['sports'])==3 and len(d['windows'])==9"
check "key dashboard"       "/api/health/keys"          "d['sports']['configured']==3 and d['gemini']['configured']==2"

echo "── key health (regressions)"
# A response WITHOUT rate-limit headers must not read as "0 quota left" and
# bench the key; and a plan restriction must never bench one either.
check "no key benched after traffic" "/api/health/keys" "d['sports']['available']==d['sports']['configured']"
check "keys report zero errors"      "/api/health/keys" "all(k['errors']==0 for k in d['sports']['keys'])"
check "daily quota tracked"          "/api/health/keys" "any(k['dayRemaining'] is not None for k in d['sports']['keys'])"
check "per-minute limit learned"     "/api/health/keys" "any(k['perMinuteLimit']==10 for k in d['sports']['keys'])"

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

echo "── ESPN data source (no key)"
ESPN_PORT=5058
DATA_SOURCE=espn SPORTS_API_KEYS= PORT=$ESPN_PORT MONGO_URI=mongodb://127.0.0.1:27017/betting_mocktest_espn \
  node --import ./test/mock-upstream.mjs src/index.js > /dev/null 2>&1 &
ESPN_SRV=$!
for i in $(seq 1 30); do curl -sf "http://localhost:$ESPN_PORT/api/health" > /dev/null 2>&1 && break; sleep 0.5; done
E="http://localhost:$ESPN_PORT"
echk() {
  local name="$1" url="$2" pred="$3" out
  out=$(curl -s --max-time 60 "$E$url" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('BADJSON'); raise SystemExit
print('OK' if ($pred) else 'FAIL')
" 2>/dev/null)
  if [ "$out" = "OK" ]; then PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$name"
  else FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s (%s)\n" "$name" "${out:-no response}"; fi
}
echk "health: ESPN, no key needed"     "/api/health" "d['sportsData']=='ok' and d['dataSource']['effective']=='espn'"
echk "football live: ESPN + TheSportsDB" "/api/games?sport=football&window=live" "sorted(g['id'] for g in d['games'])==['soccer.9001','tsdb.700001']"
echk "duplicate across feeds merged"    "/api/games?sport=football&window=live" "not any(g['id']=='tsdb.700002' for g in d['games'])"
echk "stuck 'live' entry filtered"      "/api/games?sport=football&window=live" "not any(g['id']=='tsdb.700003' for g in d['games'])"
echk "TheSportsDB adds hockey leagues"   "/api/games?sport=hockey&window=24h" "any(g['source']=='tsdb' and g['league']['name']=='German DEL' and g['league']['tier']==2 for g in d['games'])"
echk "TheSportsDB game predicts (no odds)" "/api/predictions/football/tsdb.700001?risk=mid" "d['dataSource']['feed']=='tsdb' and d['dataSource']['model']=='priors-only' and d['model']['live']['remainingMinutes']==32"
echk "live minute computed (63')"       "/api/games?sport=football&window=live" "abs(next(g for g in d['games'] if g['id']=='soccer.9001')['status']['elapsedMinutes']-63)<0.01"
echk "unpriced fixture flagged"         "/api/games?sport=football&window=24h" "any(g['id']=='soccer.9003' and g['hasOdds'] is False for g in d['games'])"
echk "league alias → tier 1 EPL"        "/api/games?sport=football&window=24h" "any(g['league']['name']=='Premier League' and g['league']['tier']==1 for g in d['games'])"
echk "live football: in-play odds"      "/api/predictions/football/soccer.9001?risk=mid" "d['dataSource']['marketKind']=='inplay' and d['dataSource']['provider']=='DraftKings'"
echk "live football: 27' left"          "/api/predictions/football/soccer.9001?risk=mid" "d['model']['live']['remainingMinutes']==27"
echk "upcoming: fitted to the market"   "/api/predictions/football/soccer.9002?risk=easy" "d['model']['source']=='market-implied' and d['dataSource']['marketKind']=='prematch' and d['model']['fit']['residual']<3"
echk "no odds → priors-only, flagged"   "/api/predictions/football/soccer.9003?risk=mid" "d['dataSource']['model']=='priors-only' and d['confidence']<=30"
echk "market fit not scored as no-data"  "/api/predictions/football/soccer.9002?risk=easy" "d['model']['dataQuality']['level']=='market' and d['confidence']>45"
echk "NBA live: Q3 5:00 → 17' left"     "/api/predictions/basketball/nba.9101?risk=mid" "d['model']['live']['remainingMinutes']==17 and d['dataSource']['liveOdds']"
echk "NBA lines are half-points"        "/api/predictions/basketball/nba.9102?risk=mid" "all(abs(float(k)%1-0.5)<1e-9 for k in d['model']['totals'])"
echk "NHL live: P2 10:00 → 30' left"    "/api/predictions/hockey/nhl.9201?risk=aggressive" "d['model']['live']['remainingMinutes']==30"
echk "suggestions include live games"   "/api/predictions/top?sport=football&window=12h&count=5" "d['liveCount']>=1 and any(p['game']['state']=='live' for p in d['predictions'])"
echk "suggestions skip unpriced games"  "/api/predictions/top?sport=football&window=12h&count=5" "d['skippedUnpriced']>=2 and all(p['game']['hasOdds'] and p['game']['source']=='espn' for p in d['predictions'])"
echk "suggestions: all sports"          "/api/predictions/top?sport=all&window=24h&count=6" "len({p['sport'] for p in d['predictions']})==3"
echk "scope live: live games only"      "/api/predictions/top?sport=all&window=live&live=true&count=6" "d['predictions'] and all(p['game']['state']=='live' for p in d['predictions'])"
echk "scope 1h: upcoming within 60 min" "/api/predictions/top?sport=all&window=1h&live=false&count=6" "d['predictions'] and all(p['game']['state']=='upcoming' and p['game']['startsInMinutes']<=60 for p in d['predictions'])"
echk "scope 3h: none live, all ≤180 min" "/api/predictions/top?sport=all&window=3h&live=false&count=6" "d['predictions'] and all(p['game']['state']=='upcoming' and p['game']['startsInMinutes']<=180 for p in d['predictions'])"
echk "scope today, live=false: no live" "/api/predictions/top?sport=all&window=24h&live=false&count=6" "d['predictions'] and not any(p['game']['state']=='live' for p in d['predictions'])"
echk "scope mix: live + upcoming"       "/api/predictions/top?sport=all&window=12h&live=true&count=6" "{p['game']['state'] for p in d['predictions']}=={'live','upcoming'}"
kill "$ESPN_SRV" 2>/dev/null

echo "── fallback: API-SPORTS key suspended → ESPN"
FB_PORT=5059
DATA_SOURCE=apisports SPORTS_API_KEYS=suspendedKey1 PORT=$FB_PORT MONGO_URI=mongodb://127.0.0.1:27017/betting_mocktest_fb \
  node --import ./test/mock-upstream.mjs src/index.js > /dev/null 2>&1 &
FB_SRV=$!
for i in $(seq 1 30); do curl -sf "http://localhost:$FB_PORT/api/health" > /dev/null 2>&1 && break; sleep 0.5; done
E="http://localhost:$FB_PORT"
echk "games still load (from ESPN)"     "/api/games?sport=football&window=live" "len(d['games'])>=1 and d['games'][0]['source']=='espn'"
echk "health reports the fallback"      "/api/health" "d['dataSource']['fellBack'] is True and d['sportsData']=='ok'"
echk "suspended key benched, labelled"  "/api/health/keys" "d['sports']['keys'][0]['benched'] and 'suspended' in (d['sports']['keys'][0]['lastError'] or '')"
kill "$FB_SRV" 2>/dev/null
node -e "const m=require('mongoose');(async()=>{for(const db of ['betting_mocktest_espn','betting_mocktest_fb']){await m.connect('mongodb://127.0.0.1:27017/'+db);await m.connection.dropDatabase();await m.disconnect();}})().catch(()=>{})" 2>/dev/null

echo "── football in-play timing model"
# Linear clock-scaling under-priced every live Over by ~9pp against DraftKings'
# live lines. These pin the corrected curve so that cannot quietly return.
timing=$(node --input-type=module -e "
const { footballRemainingShare: r } = await import('./src/services/model/liveModel.js');
const g = (m, s) => ({ sport: 'football', status: { elapsedMinutes: m, short: s } });
const firstHalf = r(g(0, '1H')) - r(g(45, 'HT'));
const ok = [
  Math.abs(firstHalf - 0.45) < 0.01,          // ~45% of goals before half-time
  r(g(60, '2H')) > (90 - 60) / 90 + 0.03,     // more left than the clock implies
  r(g(90, '2H')) > 0,                         // added time still to play at 90:00
  r(g(70, 'ET')) === 0,                       // 90-minute markets settled
].every(Boolean);
console.log(ok ? 'OK' : 'FAIL');
" 2>/dev/null)
if [ "$timing" = "OK" ]; then PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "goal timing: 45/55 split, added time, ET settled"
else FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s\n" "goal timing model"; fi

echo "── error handling"
check "unknown sport 400"   "/api/predictions/cricket/1" "'error' in d"
check "bad risk falls back" "/api/predictions/football/101?risk=banana" "d['risk']=='mid'"

echo
printf "\033[1m%d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
