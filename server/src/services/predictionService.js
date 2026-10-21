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

export async function predict({ sport, gameId, risk = 'mid', refresh = false }) {
  const profile = RISK_PROFILES[risk] ? risk : 'mid';
  const api = adapter(sport);

  const raw = await api.getGame(gameId);
  const game = raw ? annotateTier([raw])[0] : null;
  if (!game) {
    const err = new Error(`No ${sport} game found with id ${gameId}.`);
    err.status = 404;
    throw err;
  }

  const cacheKey = `pred:v3:${sport}:${gameId}:${profile}:${game.state}`;
  if (!refresh) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  // ── gather inputs (all optional except the game itself) ──────────────────
  const leagueId = game.league.id;
  const season = game.league.season;
  const [homeStats, awayStats] = await Promise.all([
    safe(api.teamStats({ leagueId, season, teamId: game.teams.home.id })),
    safe(api.teamStats({ leagueId, season, teamId: game.teams.away.id })),
  ]);

  const [h2h, homeRecent, awayRecent, rawOdds] = await Promise.all([
    safe(api.headToHead(game.teams.home.id, game.teams.away.id), []),
    safe(api.recentGames(game.teams.home.id, 6), []),
    safe(api.recentGames(game.teams.away.id, 6), []),
    env.enableOdds && game.state !== 'finished' ? safe(api.odds(gameId), null) : Promise.resolve(null),
  ]);

  const market = rawOdds ? parseOdds(rawOdds, { sport }) : null;

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
  // Odds from /odds are pre-match; for a game already under way they must not
  // be blended with the in-play model (see buildCandidates).
  const staleMarket = game.state === 'live';
  const candidates = buildCandidates({
    model,
    market,
    weight: env.marketWeight,
    teams: game.teams,
    staleMarket,
  });
  const shortlist = rankForRisk(candidates, profile, { model, market, limit: 5 });

  // ── AI layer ─────────────────────────────────────────────────────────────
  const { ai, picks, degraded, error } = await analyse({
    game,
    model,
    market,
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
    market,
    ai,
    dataSource: {
      model: modelSource,
      marketIsStale: staleMarket && Boolean(market),
      label:
        modelSource === 'team-stats'
          ? 'Team statistics + bookmaker market'
          : modelSource === 'market-implied'
            ? 'Bookmaker market only (no team stats on your API plan)'
            : 'League priors only (no team stats and no odds available)',
      canFindValue: modelSource === 'team-stats',
      note:
        modelSource === 'market-implied'
          ? 'Your sports API plan does not expose current-season team statistics, so these probabilities are the bookmakers\' own view, re-fitted into a full scoring model. That makes every market consistent and fills in lines the book did not price — but it cannot disagree with the market, so no genuine value edge is available from this data alone.'
          : modelSource === 'priors-only'
            ? 'Neither team statistics nor odds were available for this game, so the model is running on generic league averages. Treat this prediction as near-worthless.'
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
