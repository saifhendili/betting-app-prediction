import { Router } from 'express';
import { predict, RISK_PROFILES } from '../services/predictionService.js';
import { listGames } from '../services/gamesService.js';
import { SPORTS } from '../config/env.js';
import { log } from '../utils/logger.js';

export const predictionsRouter = Router();

const normRisk = (r) => {
  const key = String(r || 'mid').toLowerCase();
  const alias = { safe: 'easy', low: 'easy', balanced: 'mid', medium: 'mid', high: 'aggressive', risky: 'aggressive' };
  const resolved = alias[key] || key;
  return RISK_PROFILES[resolved] ? resolved : 'mid';
};

predictionsRouter.get('/profiles', (_req, res) => {
  res.json({
    profiles: Object.values(RISK_PROFILES).map((p) => ({
      key: p.key,
      label: p.label,
      tagline: p.tagline,
      description: p.description,
      typicalOdds: p.oddsRange,
      minProbability: p.minProbability,
    })),
  });
});

/**
 * Best bets across a whole slate. Each game costs upstream API calls plus one
 * Gemini call, so the count is capped hard — this is the expensive endpoint.
 */
/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const byTierThenKickoff = (a, b) =>
  (a.league.tier ?? 9) - (b.league.tier ?? 9) || new Date(a.kickoff || 0) - new Date(b.kickoff || 0);

// Games with odds get real predictions, so they always take the slots first;
// un-priced games only fill whatever is left.
const pricedFirst = (a, b) => (a.hasOdds === false) - (b.hasOdds === false) || byTierThenKickoff(a, b);

/**
 * Suggested bets across the slate — upcoming AND live games.
 *
 * Live games are guaranteed up to half the slots when any are on, so in-play
 * suggestions never get crowded out by a busy upcoming schedule.
 *
 * By default (`unpriced=false`, "Auto") fixtures no bookmaker prices are
 * skipped: without odds (and no team stats) the model can only produce a
 * league-average guess. With `unpriced=true` ("All games") they are kept and
 * fill the remaining slots after every priced game — clearly labelled, and
 * still analysed, but at the low confidence they deserve.
 */
predictionsRouter.get('/top', async (req, res, next) => {
  try {
    const sport = String(req.query.sport || 'football').toLowerCase();
    if (sport !== 'all' && !SPORTS.includes(sport)) {
      const err = new Error(`Unknown sport "${sport}"`);
      err.status = 400;
      throw err;
    }
    const risk = normRisk(req.query.risk);
    const count = Math.min(Math.max(Number(req.query.count) || 10, 1), 25);
    const windowKey = String(req.query.window || '12h').toLowerCase();
    const lean = String(req.query.lean ?? 'true') !== 'false';
    const includeLive = String(req.query.live ?? 'true') !== 'false';
    const includeUnpriced = String(req.query.unpriced ?? 'false') === 'true';

    const slate = await listGames({ sport, window: windowKey, limit: 300 });
    let pool = slate.games;
    if (includeLive && windowKey !== 'live') {
      // hour windows list upcoming games only — add whatever is on right now
      const live = await listGames({ sport, window: 'live', limit: 300 }).catch(() => null);
      if (live) pool = [...live.games, ...pool];
    }

    const seen = new Set();
    pool = pool.filter((g) => {
      if (seen.has(g.gameKey)) return false;
      seen.add(g.gameKey);
      return g.state !== 'finished';
    });
    const unpriced = pool.filter((g) => g.hasOdds === false).length;
    if (!includeUnpriced) pool = pool.filter((g) => g.hasOdds !== false);

    // `live=false` means upcoming ONLY: day windows list games in progress too,
    // so they must be dropped here, not just given zero reserved slots (the
    // top-up below would otherwise pull them straight back in).
    const liveGames = includeLive ? pool.filter((g) => g.state === 'live').sort(pricedFirst) : [];
    const upcomingGames = pool.filter((g) => g.state === 'upcoming').sort(pricedFirst);

    const liveSlots = includeLive ? Math.min(liveGames.length, windowKey === 'live' ? count : Math.ceil(count / 2)) : 0;
    const shortlist = [...liveGames.slice(0, liveSlots), ...upcomingGames.slice(0, count - liveSlots)];
    // top up from whichever group still has games if the other ran short
    for (const g of [...liveGames.slice(liveSlots), ...upcomingGames.slice(count - liveSlots)]) {
      if (shortlist.length >= count) break;
      if (!shortlist.includes(g)) shortlist.push(g);
    }

    // ESPN and TheSportsDB games cost no metered request, so they run a few at a
    // time (bounded by Gemini's own rate limits). API-SPORTS games stay strictly
    // sequential: its 10 requests/minute cap is what used to bench the key.
    const metered = shortlist.some((g) => g.source === 'apisports');
    const settled = await mapPool(shortlist, metered ? 1 : 3, async (g) => {
      try {
        return { ok: true, value: await predict({ sport: g.sport, gameId: g.id, risk, preloadedGame: g, lean }) };
      } catch (err) {
        return { ok: false, err };
      }
    });

    const predictions = [];
    const failures = [];
    settled.forEach((r, i) => {
      if (r.ok) predictions.push(r.value);
      else {
        failures.push({ game: shortlist[i]?.gameKey, message: r.err?.message || String(r.err) });
        log.warn(`suggestions: ${shortlist[i]?.gameKey} failed — ${r.err?.message}`);
      }
    });

    predictions.sort((a, b) => b.confidence - a.confidence);

    res.json({
      sport,
      risk,
      window: slate.window,
      scope: { window: windowKey, includeLive, includeUnpriced },
      requested: shortlist.length,
      slateSize: slate.counts.total,
      liveCount: predictions.filter((p) => p.game.state === 'live').length,
      unpricedCount: predictions.filter((p) => p.game.hasOdds === false).length,
      skippedUnpriced: includeUnpriced ? 0 : unpriced,
      lean,
      failures,
      predictions,
    });
  } catch (err) {
    next(err);
  }
});

predictionsRouter.get('/:sport/:id', async (req, res, next) => {
  try {
    const sport = String(req.params.sport).toLowerCase();
    if (!SPORTS.includes(sport)) {
      const err = new Error(`Unknown sport "${sport}". Use: ${SPORTS.join(', ')}`);
      err.status = 400;
      throw err;
    }
    const data = await predict({
      sport,
      gameId: req.params.id,
      risk: normRisk(req.query.risk),
      refresh: String(req.query.refresh || '') === 'true' || req.query.refresh === '1',
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
