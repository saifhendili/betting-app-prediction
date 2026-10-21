import { Router } from 'express';
import { env, SPORTS } from '../config/env.js';
import { isMongoUp } from '../db/connect.js';
import { sportsKeys, sportsUsage } from '../services/sportsApi/index.js';
import { geminiKeys, geminiUsage } from '../services/gemini/client.js';
import { cacheStats } from '../services/cache.js';
import { windowList } from '../services/gamesService.js';
import { RISK_PROFILES } from '../services/model/picks.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const geminiOk = geminiKeys.available().length > 0;
  const sportsOk = sportsKeys.available().length > 0;
  res.json({
    status: sportsOk ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    timezone: env.timezone,
    mongo: isMongoUp() ? 'connected' : 'offline (in-memory cache)',
    sportsData: sportsOk ? 'ok' : sportsKeys.size ? 'all keys rate-limited' : 'no key configured',
    ai: geminiOk ? 'ok' : geminiKeys.size ? 'all keys rate-limited' : 'no key configured (model-only predictions)',
    cache: cacheStats(),
  });
});

/** Key dashboard — how much of each free quota is left, per key. */
healthRouter.get('/keys', (_req, res) => {
  res.json({
    gemini: { ...geminiKeys.health(), usage: geminiUsage(), model: env.gemini.model, fallbacks: env.gemini.fallbackModels },
    sports: {
      ...sportsKeys.health(),
      usage: sportsUsage(),
      provider: env.sports.provider,
      note: 'API-SPORTS free tier allows 100 requests/day per sport, per key.',
    },
  });
});

healthRouter.get('/meta', (_req, res) => {
  res.json({
    sports: SPORTS.map((key) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      icon: { football: '⚽', basketball: '🏀', hockey: '🏒' }[key],
    })),
    windows: windowList(),
    risks: Object.values(RISK_PROFILES).map((p) => ({
      key: p.key,
      label: p.label,
      tagline: p.tagline,
      description: p.description,
    })),
    config: { marketWeight: env.marketWeight, oddsEnabled: env.enableOdds, timezone: env.timezone },
  });
});
