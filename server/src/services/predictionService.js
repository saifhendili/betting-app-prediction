import { env } from '../config/env.js';
import { adapter } from './sportsApi/index.js';
import { annotateTier } from './leagues.js';
import { footballModel } from './model/footballModel.js';
import { basketballModel } from './model/basketballModel.js';
import { hockeyModel } from './model/hockeyModel.js';
import { parseOdds } from './model/odds.js';
import { applyLiveState } from './model/liveModel.js';
import { modelFromMarket } from './model/marketFit.js';
import { planRestrictions } from './sportsApi/index.js';
import { buildCandidates, rankForRisk, RISK_PROFILES } from './model/picks.js';
import { analyse } from './gemini/analyst.js';
import { Prediction } from '../models/Prediction.js';
import { isMongoUp } from '../db/connect.js';
import { cacheGet, cacheSet } from './cache.js';
import { clamp } from './model/math.js';
import { log } from '../utils/logger.js';

const MODELS = { football: footballModel, basketball: basketballModel, hockey: hockeyModel };

/** Live games get a short cache so the scoreline stays current. */
const ttlFor = (game) => (game.state === 'live' ? 120 : env.ttl.prediction);

async function safe(promise, fallback = null) {
  try {
    return await promise;
  } catch (err) {
    log.warn(`optional fetch failed: ${err.message}`);
    return fallback;
  }
}

/**
 * @param preloadedGame  A game object already fetched by the caller (the slate
 *   listing has one for every fixture). Passing it saves a whole upstream
 *   request per prediction — on a 100/day plan that is the difference between
 *   5 bulk predictions and 15.
 * @param lean  Skip the optional head-to-head fetch. Used for bulk runs, where
 *   breadth matters more than the extra context for the AI narrative.
 */
export async function predict({
  sport,
  gameId,
  risk = 'mid',
  refresh = false,
  preloadedGame = null,
  lean = false,
}) {
  const profile = RISK_PROFILES[risk] ? risk : 'mid';
  // route by id: an ESPN game is always predicted from ESPN, whatever the
  // listing source is set to now
  const api = adapter(sport, { gameId });

  // Reuse the caller's copy when it is the same fixture and still fresh enough.
  const raw =
    preloadedGame && String(preloadedGame.id) === String(gameId) ? preloadedGame : await api.getGame(gameId);
  const game = raw ? annotateTier([raw])[0] : null;
  if (!game) {
    const err = new Error(`No ${sport} game found with id ${gameId}.`);
    err.status = 404;
    throw err;
  }

  // a goal must invalidate a live prediction immediately, so the score is part
  // of the key while the game is on
  const scoreKey = game.state === 'live' ? `:${game.score.home ?? 0}-${game.score.away ?? 0}` : '';
  const cacheKey = `pred:v4:${sport}:${gameId}:${profile}:${game.state}${scoreKey}`;
  if (!refresh) {
    const hit = await cacheGet(cacheKey);
    // The analysis can be reused, but the game itself must be current: a cached
    // payload otherwise carries the countdown / live minute from when it was
    // first computed ("kicks off in 183 min" inside a 3-hour window).
    if (hit) return { ...hit, game, cached: true };
  }

  // ── gather inputs (all optional except the game itself) ──────────────────
  const leagueId = game.league.id;
  const season = game.league.season;
  const [homeStats, awayStats] = await Promise.all([
    safe(api.teamStats({ leagueId, season, teamId: game.teams.home.id })),
    safe(api.teamStats({ leagueId, season, teamId: game.teams.away.id })),
  ]);

  const isLive = game.state === 'live';
  const wantOdds = env.enableOdds && game.state !== 'finished';

  const [h2h, homeRecent, awayRecent, rawOdds, rawLiveOdds] = await Promise.all([
    lean ? Promise.resolve([]) : safe(api.headToHead(game.teams.home.id, game.teams.away.id), []),
    safe(api.recentGames(game.teams.home.id, 6), []),
    safe(api.recentGames(game.teams.away.id, 6), []),
    wantOdds ? safe(api.odds(gameId, { snapshot: 'prematch' }), null) : Promise.resolve(null),
    // In-play prices exist only on feeds that carry them (ESPN does).
    wantOdds && isLive && api.supportsLiveOdds ? safe(api.odds(gameId, { snapshot: 'current' }), null) : Promise.resolve(null),
  ]);

  // Pre-match prices: what team strength is fitted to, even for a live game.
  const market = rawOdds ? parseOdds(rawOdds, { sport }) : null;
  // In-play prices: what a live bet can actually be placed at right now.
  const liveMarket = rawLiveOdds ? parseOdds(rawLiveOdds, { sport }) : null;

  // ── pick a model source ─────────────────────────────────────────────────
  // Team statistics are the best input, but they are unavailable on API-SPORTS
  // free plans for the current season. Rather than fall back to league priors
  // (which would give every game the same prediction), invert the bookmaker
  // odds into scoring parameters — see services/model/marketFit.js.
  let preMatch = null;
  let modelSource = null;

  if (homeStats || awayStats) {
    preMatch = MODELS[sport]({ home: homeStats, away: awayStats, homeRecent, awayRecent });
    preMatch.source = 'team-stats';
    modelSource = 'team-stats';
  } else {
    const fitted = modelFromMarket(sport, market);
    if (fitted) {
      preMatch = fitted;
      modelSource = 'market-implied';
    } else {
      preMatch = MODELS[sport]({ home: null, away: null, homeRecent, awayRecent });
      preMatch.source = 'priors-only';
      modelSource = 'priors-only';
    }
  }

  // For a game in progress, rebase the projection on the scoreline and the
  // time left — otherwise every live pick would be priced as if 0-0 at kickoff.
  const model = applyLiveState(preMatch, game);
  model.source = modelSource;

  // ── candidates → risk ranking ────────────────────────────────────────────
  // Which prices the picks are compared against:
  //   upcoming            → pre-match prices
  //   live + in-play odds → the in-play prices (both sides know the score)
  //   live, no in-play    → pre-match prices shown for reference only; they
  //                         don't know the score, so they are not blended in
  const pickMarket = isLive && liveMarket ? liveMarket : market;
  const marketKind = !pickMarket ? 'none' : isLive ? (liveMarket ? 'inplay' : 'stale-prematch') : 'prematch';
  const staleMarket = marketKind === 'stale-prematch';

  const candidates = buildCandidates({
    model,
    market: pickMarket,
    weight: env.marketWeight,
    teams: game.teams,
    staleMarket,
  });
  const shortlist = rankForRisk(candidates, profile, { model, market: pickMarket, limit: 5 });

  // ── AI layer ─────────────────────────────────────────────────────────────
  const { ai, picks, degraded, error } = await analyse({
    game,
    model,
    market: pickMarket,
    marketKind,
    picks: shortlist,
    risk: profile,
    h2h,
    recent: { home: homeRecent, away: awayRecent },
  });

  const top = picks[0];
  const engine = ['model', market ? 'market' : null, ai ? 'gemini' : null].filter(Boolean).join('+');

  // Final headline confidence: the pick's own score, nudged toward the AI's
  // reading, then capped by how good the underlying data actually was.
  let confidence = top?.confidence ?? 40;
  if (ai?.confidence != null) confidence = Math.round(confidence * 0.65 + ai.confidence * 0.35);
  if (ai?.verdict === 'pass') confidence = Math.min(confidence, 45);
  if (model.dataQuality.level === 'none') confidence = Math.min(confidence, 35);
  if (model.dataQuality.level === 'partial') confidence = Math.min(confidence, 50);
  if (model.dataQuality.level === 'market-loose') confidence = Math.min(confidence, 62);
  if (modelSource === 'priors-only') confidence = Math.min(confidence, 30);
  confidence = Math.round(clamp(confidence, 5, 96));

  const payload = {
    sport,
    gameId: String(gameId),
    risk: profile,
    riskProfile: {
      key: profile,
      label: RISK_PROFILES[profile].label,
      tagline: RISK_PROFILES[profile].tagline,
    },
    game,
    generatedAt: new Date().toISOString(),
    engine,
    degraded: degraded || null,
    degradedReason: error || null,
    confidence,
    headline:
      ai?.headline ||
      (top ? `${top.selection} — ${(top.probability * 100).toFixed(0)}% model probability` : 'No pick available'),
    verdict: ai?.verdict || (confidence >= 65 ? 'strong' : confidence >= 50 ? 'lean' : 'pass'),
    topPick: top || null,
    picks,
    model,
    // the prices the picks were compared with (in-play for a live game when
    // the feed has them), plus the pre-match ones the model was fitted to
    market: pickMarket,
    prematchMarket: market,
    ai,
    dataSource: {
      feed: game.source || 'apisports',
      provider: pickMarket?.bookmakers?.[0] || null,
      model: modelSource,
      marketKind,
      marketIsStale: staleMarket,
      liveOdds: marketKind === 'inplay',
      label:
        modelSource === 'team-stats'
          ? 'Team statistics + bookmaker market'
          : modelSource === 'market-implied'
            ? 'Bookmaker market (no team statistics available)'
            : 'League averages only (this fixture has no odds)',
      // In-play, the model (pre-match strength rebased on the score) and the
      // live market are genuinely independent views, so a gap is meaningful.
      canFindValue: modelSource === 'team-stats' || marketKind === 'inplay',
      note:
        modelSource === 'market-implied' && marketKind !== 'inplay'
          ? 'No team statistics are available from the data source, so these probabilities are the bookmaker\'s own view, re-fitted into a full scoring model. That makes every market consistent and fills in lines the book did not price — but it cannot disagree with the market, so no genuine value edge is available pre-match.'
          : modelSource === 'priors-only'
            ? 'No odds are available for this fixture — either no bookmaker prices it (friendlies, youth and minor leagues), or it comes from the wider-coverage feed, which carries scores but no prices — and there are no team statistics, so the model is running on generic league averages. Treat this prediction as near-worthless.'
            : null,
      planRestrictions: planRestrictions(),
    },
    context: {
      h2h: (h2h || []).slice(-6),
      recent: { home: (homeRecent || []).slice(-5), away: (awayRecent || []).slice(-5) },
      stats: { home: homeStats, away: awayStats },
      dataQuality: model.dataQuality,
      oddsAvailable: Boolean(market),
      bookmakers: market?.bookmakers || [],
    },
  };

  await cacheSet(cacheKey, payload, ttlFor(game));

  // persist for history / later accuracy review
  if (isMongoUp()) {
    Prediction.updateOne(
      { cacheKey },
      {
        $set: {
          cacheKey,
          sport,
          fixtureId: String(gameId),
          risk: profile,
          kickoff: game.kickoff ? new Date(game.kickoff) : null,
          teams: { home: game.teams.home.name, away: game.teams.away.name },
          league: game.league.name,
          model,
          market,
          ai,
          picks: picks.map((p) => ({
            market: p.market,
            selection: p.selection,
            probability: p.probability,
            fairOdds: p.fairOdds,
            marketOdds: p.marketOdds,
            edge: p.edge,
            confidence: p.confidence,
            stars: p.stars,
            reason: null,
          })),
          headline: payload.headline,
          confidence,
          engine,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      },
      { upsert: true }
    ).catch(() => {});
  }

  return payload;
}

export { RISK_PROFILES };
