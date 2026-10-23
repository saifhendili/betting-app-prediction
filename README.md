# 🎯 Betting Oracle

A MERN application that lists **live and upcoming football, basketball and hockey games** and produces
a prediction for each one — match winner, over/under, handicap, double chance, BTTS — at three
selectable risk levels (**Easy / Mid / Aggressive**).

Predictions are **not** "ask an LLM who wins". They are built in three layers:

1. **A statistical model.** Season and recent-form scoring rates feed a Dixon-Coles-corrected Poisson
   model (football, hockey) or a normal scoring model (basketball), with Bayesian shrinkage toward
   league priors so a team with four games played doesn't get treated as a known quantity.
2. **The bookmaker market.** Odds are pulled, the vig is stripped, and the market is fused with the
   model. The market's weight rises as the disagreement grows, because a large gap is nearly always
   the model missing information rather than free money.
3. **Gemini.** The AI gets the computed numbers (never raw "who wins?"), picks the best candidate for
   your risk profile, writes the reasoning, flags the risks, and may nudge probabilities by at most
   ±8 percentage points — clamped server-side.

If Gemini is unavailable the app degrades to a pure statistical prediction instead of failing.

---

## What it does

| Feature | Detail |
|---|---|
| **Sports** | Football ⚽, Basketball 🏀, Hockey 🏒, or all three at once |
| **Time windows** | Live now · next 1h / 3h / 6h / 12h / 24h · Today · Tomorrow · both days |
| **Horizon** | Today and tomorrow only, by design — predictions decay and the free quota is small |
| **Risk profiles** | Easy (high hit-rate, ~1.1–1.7) · Mid (main lines, ~1.4–2.6) · Aggressive (value hunting, 1.8+) |
| **Live games** | Probabilities are **rebased on the scoreline and time remaining**, not pre-match numbers |
| **Markets** | Match winner, double chance, over/under (every line the book prices), handicap, BTTS, correct score |
| **Suggested bets** | One click analyses 5–25 games — **live and upcoming** — and gives each a best bet plus its other options |
| **Saved results** | Every suggestions run is saved automatically, and any bet can be starred ☆; both live in your browser (localStorage) |
| **Data** | ESPN by default — no key, no daily limit, DraftKings odds including **live in-play prices**. API-SPORTS optional |
| **Many API keys** | Gemini (and API-SPORTS, if used) take any number of keys, rotated automatically |

---

## Quick start

```bash
git clone <this repo> && cd betting
npm run install:all
```

### 1. Start it

```bash
npm run mongo:up   # optional; see below
npm run dev
```

Then open http://localhost:5173 and click the **⚙️ gear icon** (top right).

### 2. Paste your keys into Settings

No `.env` editing needed — the panel takes the keys, validates them against the live providers, and
applies them immediately without a restart.

**Gemini** — https://aistudio.google.com/apikey → create API key. Free tier, no card.
Paste **several, one per line**; they are rotated, so N keys ≈ N× the free daily quota.

**Sports data** — nothing to do. The default source is ESPN's public scoreboard, which needs no key.
(API-SPORTS is available as an alternative in Settings; see *Data sources* below.)

Hit **Test keys** first if you want to confirm they work — it checks each one against Google and the
sports provider and reports the plan and quota used, without spending any generation quota. Then
**Save**. Keys live in your local MongoDB and are only ever shown masked afterwards.

> `.env` still works as a fallback (`GEMINI_API_KEYS=k1,k2,k3`, `SPORTS_API_KEYS=...`) and is handy for
> deployments. Anything saved in Settings takes precedence over it.

### 3. MongoDB

```bash
npm run mongo:up      # Docker, one-off
npm run mongo:start   # subsequent starts
```

Or point `MONGO_URI` at a free Atlas cluster. **Mongo is optional** — without it the app falls back to
an in-memory cache and keeps working; keys saved in Settings stay active for the session but won't
survive a restart (the panel tells you when that's the case, and `.env` is the durable option then).

- UI → http://localhost:5173
- API → http://localhost:5000/api/health

For production, see **Hosting** below — one process serves both the UI and the API.

---

## Data sources

| | ESPN (default) | + TheSportsDB (merged in) | API-SPORTS (optional) |
|---|---|---|---|
| Key | none | published free key | required |
| Limits | none | generous free tier | free plan: 100 requests/day, 10/minute |
| Coverage | ~50 football leagues on a given day (220 catalogued), NBA, WNBA, NCAA, NHL | many more: Asia, Eastern Europe, second divisions; EuroLeague, CBA, B1, DEL, SHL, Swiss NL… | ~1,100 leagues |
| Odds | DraftKings, **including live in-play prices** | none (scores only) | many books, pre-match on the free plan |
| Team statistics | no | no | paid plans only |

By default the app lists **ESPN and TheSportsDB together**: ESPN supplies every fixture it covers
(those carry odds), and TheSportsDB adds the ones ESPN lacks. The same match in both feeds is merged
into one — team names are compared on their distinctive words, so "AFC Bournemouth" and "Bournemouth"
or "Lillestrøm" and "Lillestrom" line up, while Real Madrid and Real Betis don't — and entries stuck
"in play" for hours after kick-off are dropped. Measured on a Friday midday: **1 → 10 live football
games, 1 → 53 basketball and 0 → 83 hockey games for the day.** Set `ENABLE_TSDB=false` to turn it
off.

TheSportsDB games show live scores and get an in-play prediction, but with no odds and no team
statistics it is a league-average one, clearly labelled, and Suggested bets skips them. Within a
competition tier, priced games sort first.

Even merged, this is not every match on earth: sites like Flashscore track well over a thousand
competitions. A paid API-SPORTS plan (~1,100 leagues, with odds) is the step up if you need that —
the app switches to it from Settings.

ESPN's scoreboard is ESPN's own site API rather than a documented public product. It has been stable
for years, but it can change without notice — which is one reason API-SPORTS is kept as an option.

If API-SPORTS is selected and its key turns out missing, exhausted or **suspended**, the app hands over
to ESPN by itself and says so in `/api/health` and the Settings panel, rather than showing no games.

Fixtures no bookmaker prices — friendlies, youth and minor leagues — are still listed (marked
*no odds*), but they are skipped by Suggested bets: with no prices and no team statistics the model
can only produce a league-average guess.

### Live betting

For a game in progress the model is **pre-match team strength, rebased on the score and the time
left**, and it is compared against the bookmaker's **current in-play price** — so the edge column shows
the gap to a price you could actually take now. When a fixture has no in-play market, the pre-match
price is still shown (greyed, as "pre 1.91") but never treated as bettable or used for ranking.

Goal timing matters here. Scaling the remaining expectation linearly by the clock is wrong: about 45%
of goals come in the first half and 55% in the second, and added time makes a match ~98 minutes long.
Measured against DraftKings' live totals across 16 in-play games, the linear version under-priced
every Over, by 9 percentage points on average — it would have suggested an Under on almost every live
game. With the timing model the average gap is ~1pp, with disagreements on both sides.

## Suggested bets & saved results

**💡 Suggested bets** picks the strongest priced games in the current window and returns, for each, a
best bet for your risk level plus the other options (tap *+N more bet options*). Live games are
always included — up to half the slots when any are on — and on the *Live* tab the list is live-only.
Choose how many games (5–25) next to the button.

**Saving** happens in your browser (localStorage), nothing on the server:

- every suggestions run is saved automatically — *📁 Saved → Suggestion history*
- tap ☆ on any bet, in Suggested bets or in a game's analysis, to keep it in *📁 Saved → Saved bets*

Each entry records the game as it was when saved — including the score and minute of a live game —
with the pick, its probability and the price. *Open* fetches a fresh prediction for that game.

## Hosting

**There is no CORS to configure.** The API and the UI are served from the same origin: in production
this one Node process serves `client/dist` itself, and in development Vite proxies `/api` through to
it. The browser never makes a cross-origin request. The client calls relative `/api/...` paths, so
there is no API URL to set either — the app works unchanged on localhost, a LAN IP or a public domain.

(The flip side, deliberately: this API is not callable from a web page on another domain.)

### Run it like production, locally

```bash
npm run serve          # builds the UI, then starts on http://localhost:5000
```

### Docker — works on any host

```bash
npm run docker:build
npm run docker:run     # http://localhost:5000
```

A multi-stage build: the UI is compiled in a throwaway stage, the runtime image carries only
production dependencies, runs as a non-root user, and has a `/api/health` healthcheck. ~289 MB.

### Deploy

The app is stateless — all state lives in MongoDB — so any container host works and you can scale to
several instances.

| Host | Steps |
|---|---|
| **Render** | Push to GitHub → New → Blueprint → pick this repo. `render.yaml` is already set up; add `MONGO_URI` in the dashboard. |
| **Fly.io** | `fly launch --no-deploy` → `fly secrets set MONGO_URI="..." ADMIN_TOKEN="$(openssl rand -hex 24)"` → `fly deploy`. `fly.toml` included. |
| **Railway / Koyeb / Cloud Run** | Point at the `Dockerfile`. Set the env vars below. The platform's `PORT` is picked up automatically. |

Environment variables for a deployment:

```env
NODE_ENV=production
MONGO_URI=mongodb+srv://USER:PASS@CLUSTER.mongodb.net/bettingapp?retryWrites=true&w=majority
ADMIN_TOKEN=<openssl rand -hex 24>
TIMEZONE=Europe/Paris
```

API keys do **not** need to be environment variables — enter them in the app's Settings panel once
deployed and they are stored in MongoDB. `GEMINI_API_KEYS` / `SPORTS_API_KEYS` still work as a
fallback if you prefer them in the environment.

### Before you expose it publicly

- **Set `ADMIN_TOKEN`.** Without it, anyone who can reach the URL can open Settings and replace your
  API keys or spend your daily quota. With it, `PUT /api/settings` and `POST /api/settings/test`
  require an `x-admin-token` header; the Settings panel shows a field for it and remembers it in that
  browser. Reading games and predictions stays public — that's the app itself. The server logs a
  warning on boot if `NODE_ENV=production` and no token is set.
- **Your Gemini quota is shared by every visitor.** Each new prediction is one Gemini call. With ESPN
  as the data source there is no sports quota to worry about; with API-SPORTS, 100 requests/day are
  shared across all users.
- **Lock down MongoDB.** Use a strong password and restrict the Atlas IP allowlist to your host rather
  than `0.0.0.0/0`.
- `server/.env` is gitignored — keep it that way, and set secrets through your host's dashboard.

## Multiple API keys

This is a first-class feature, because the free tiers are small. Add as many as you like in
**⚙️ Settings** (one per line), or in `.env`:

```env
GEMINI_API_KEYS=key1,key2,key3,key4
SPORTS_API_KEYS=sportkey1,sportkey2
```

- Keys are used **round-robin**.
- A key that returns `429`/quota/invalid is **benched** (15 min for Gemini, 30 min for sports data,
  6 h for a rejected key) and skipped until it recovers.
- A single request is retried across **every available key**, then across the fallback models.
- Live status per key: **`GET /api/health/keys`** — calls, errors, whether it's benched and for how long.

Because of the quota, the app caches aggressively: fixtures 15 min, live scores 45 s, team statistics
12 h, odds 30 min, predictions 30 min (2 min for live games). Odds are fetched **only** when you ask
for a specific prediction, never for a whole list.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Service + key + DB status |
| `GET /api/health/keys` | Per-key usage dashboard |
| `GET /api/health/meta` | Sports, windows and risk profiles for the UI |
| `GET /api/settings` | Current config with **masked** keys and their source (settings / env) |
| `PUT /api/settings` | Save keys, model or provider. Partial patches only touch the fields sent |
| `POST /api/settings/test` | Validate keys against Google and the sports provider |
| `GET /api/games?sport=football&window=3h` | The slate. `sport` = football·basketball·hockey·all |
| `GET /api/games/:sport/:id` | One game |
| `GET /api/predictions/:sport/:id?risk=mid` | Full prediction. `refresh=1` bypasses the cache |
| `GET /api/predictions/top?sport=football&window=12h&risk=mid&count=5` | Best bets across the slate |
| `GET /api/predictions/profiles` | Risk profile definitions |

`risk` accepts `easy`·`mid`·`aggressive` (plus aliases `safe`, `balanced`, `high`).

---

## How the model works

**Football / hockey — Poisson.** Expected goals blend "what the home side scores at home" with "what
the away side concedes away", shrunk toward a league prior with weight `k=6` games, then multiplied by
a damped recent-form factor (clamped to ±20%). A Dixon-Coles `τ` correction (`ρ = −0.05`) fixes
independent Poisson's known under-pricing of 0-0 and 1-1. The score matrix then yields 1X2, every
over/under line, BTTS, handicaps and correct scores. Hockey folds the regulation draw into the
moneyline at a 52/48 home split for overtime.

**Basketball — normal.** Projected points per side from the same for/against blend; margin and total
are normal with `sd` proportional to the projected total, inflated by `√(1 + 8/n)` so an 11-point
projection off 8 games doesn't claim the certainty of one off 60.

**Live games.** The remaining expectation is scaled by the time left, the remaining-goals
distribution is computed, and the current score is added back as a fixed offset. So at 1-0 after
63 minutes the home side reads ~83% rather than the pre-match 52%, and already-settled selections are
dropped from the candidate list entirely.

**Market fusion.** Odds are de-vigged multiplicatively (`p = (1/o) / Σ(1/o)`), taking the median price
across every bookmaker that quoted the selection. Base market weight is `MARKET_WEIGHT` (0.55); it
rises toward 0.88 as model and market diverge. Two expected values are reported: `ev` from the blended
probability (the honest, vig-aware number — usually slightly negative) and `evModel` from the model
alone (the value signal the aggressive profile hunts).

**Risk profiles** filter and rank the candidate list by probability, price and value, and never return
contradictory picks (no over *and* under on one line, no both sides of a handicap).

---

## Project layout

```
server/
  src/services/
    sportsApi/     per-sport adapters → one normalised game shape
    model/         math · football/basketball/hockey models · live model · odds · picks
    gemini/        key-rotating REST client · prompt · analyst
    predictionService.js   orchestrates everything
  test/mock-upstream.mjs   canned upstream for testing without quota
client/
  src/components/  controls · game list · prediction panel · top picks
```

### Testing without burning quota

The upstream feeds are mocked, so the whole pipeline can be exercised for free.

```bash
cd server
./test/smoke.sh        # 68 end-to-end checks, no API quota consumed
```

It covers every sport × risk combination, the time-window filters, the in-play rebasing, the
settings API, the admin-token gate, the ESPN feed, the fallback from a suspended API-SPORTS key,
the goal-timing model, and the invariants that matter (fair odds = 1/p, 1X2 sums to 1,
no contradictory picks, no settled markets).

To poke at it by hand:

```bash
node --import ./test/mock-upstream.mjs src/index.js   # port 5055, canned upstream
curl "localhost:5055/api/predictions/football/101?risk=aggressive"
curl "localhost:5055/api/predictions/football/999?risk=mid"   # a game in progress

node --import ./test/mock-failover.mjs src/index.js   # port 5056, dead keys
curl "localhost:5056/api/health/keys"                 # watch the pool bench them
```

---

## What the free API-SPORTS plan actually allows

Only relevant if you switch the data source to API-SPORTS. Worth knowing before you judge the predictions. On the API-SPORTS **free** plan, the *current season*
is not readable — only seasons 2022–2024 — and the `last` parameter is blocked entirely. Measured
against a live key:

| Call | Free plan |
|---|---|
| `/fixtures?date=` · `/games?date=` · `?live=all` | ✅ works (all three sports) |
| `/odds?fixture=` | ✅ works (10+ bookmakers) |
| `/fixtures/headtohead?h2h=` *(without `last`)* | ✅ works |
| `/teams/statistics` · `/standings` · `?season=<current>` | ❌ *"Free plans do not have access to this season"* |
| `?last=N` | ❌ *"Free plans do not have access to the Last parameter"* |

So on a free key there is **no current-season team data at all**. Rather than fall back to league
averages — which would give every game an identical prediction — the app inverts the odds: it fits
scoring parameters whose implied distribution reproduces every price the book published (typically to
within 1–2 percentage points), then derives all the markets the book *didn't* price from that same
distribution. The payload reports `dataSource.model` as `market-implied`, and the UI says plainly that
no independent edge is available from market data alone.

Two consequences, both surfaced in the UI rather than hidden:

- **The "Easy/Mid/Aggressive" split still works** (it is a ranking over a coherent distribution), but
  **aggressive value-hunting does not** — you cannot disagree with a market that is your only source.
- **Upgrading the sports plan is the single biggest quality improvement available.** The statistical
  model, form weighting and value detection are all implemented and switch on automatically the moment
  `/teams/statistics` starts answering; `dataSource.model` then reads `team-stats`.

The app also **remembers plan restrictions for 6 hours** instead of rediscovering them on every
request — without that, four doomed calls per prediction would eat most of a 100/day budget.

## Limitations — read these

- **No injury, lineup, suspension, weather or motivation data.** The feed doesn't provide it on the
  free plan, and Gemini is explicitly instructed not to invent it. This is the single biggest gap
  between these numbers and a sharp bettor's.
- **In-play odds depend on the bookmaker quoting the game.** ESPN carries DraftKings' live prices when
  they exist; when a game has none (and always on API-SPORTS, which is pre-match only), the pre-match
  price is used to fit team strength but never blended with the in-play model, ranked on, or shown as
  bettable — a stale quote does not know the score.
- **One bookmaker on ESPN.** DraftKings only, so there is no cross-book consensus; the de-vig still
  removes its margin.
- **The bookmaker margin means no model wins long term.** The honest `ev` figure is usually
  negative. A positive `evModel` is a hypothesis, not a guarantee.
- **100 requests/day/sport** on the free plan goes quickly. Watch `/api/health/keys`.
- **Early season predictions are weak** — the UI labels data quality `none`/`partial`/`low` for
  exactly this reason. Trust the `low` ones least.
- This is a modelling tool, not financial advice. **Bet only what you can afford to lose.**
