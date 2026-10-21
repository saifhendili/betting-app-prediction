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
predictionsRouter.get('/top', async (req, res, next) => {
  try {
    const sport = String(req.query.sport || 'football').toLowerCase();
    if (sport !== 'all' && !SPORTS.includes(sport)) {
      const err = new Error(`Unknown sport "${sport}"`);
      err.status = 400;
      throw err;
    }
    const risk = normRisk(req.query.risk);
    const count = Math.min(Math.max(Number(req.query.count) || 5, 1), 10);
    const windowKey = String(req.query.window || '12h').toLowerCase();

    const slate = await listGames({ sport, window: windowKey, limit: 60 });
    // prioritise the biggest competitions, and never predict a finished game
    const shortlist = slate.games
      .filter((g) => g.state !== 'finished')
      .sort((a, b) => (a.league.tier ?? 9) - (b.league.tier ?? 9))
      .slice(0, count);

    const settled = await Promise.allSettled(
      shortlist.map((g) => predict({ sport: g.sport, gameId: g.id, risk }))
    );

    const predictions = [];
    const failures = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') predictions.push(s.value);
      else {
        failures.push({ game: shortlist[i]?.gameKey, message: s.reason?.message || String(s.reason) });
        log.warn(`top-picks: ${shortlist[i]?.gameKey} failed — ${s.reason?.message}`);
      }
    });

    predictions.sort((a, b) => b.confidence - a.confidence);

    res.json({
      sport,
      risk,
      window: slate.window,
      requested: shortlist.length,
      slateSize: slate.counts.total,
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
