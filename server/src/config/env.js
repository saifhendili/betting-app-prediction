import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const list = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('key_') && !s.startsWith('your_'));

const num = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: num(process.env.PORT, 5000),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/betting',

  // When set, changing API keys through /api/settings requires this token.
  // Only matters once the app is reachable by anyone but you.
  adminToken: (process.env.ADMIN_TOKEN || '').trim() || null,

  gemini: {
    keys: list(process.env.GEMINI_API_KEYS),
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    fallbackModels: list(process.env.GEMINI_FALLBACK_MODELS).length
      ? list(process.env.GEMINI_FALLBACK_MODELS)
      : ['gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    timeoutMs: num(process.env.GEMINI_TIMEOUT_MS, 30000),
  },

  sports: {
    keys: list(process.env.SPORTS_API_KEYS),
    provider: (process.env.SPORTS_API_PROVIDER || 'apisports').toLowerCase(),
  },

  timezone: process.env.TIMEZONE || 'Europe/Paris',
  enableOdds: String(process.env.ENABLE_ODDS ?? 'true') !== 'false',
  marketWeight: Math.min(1, Math.max(0, num(process.env.MARKET_WEIGHT, 0.55))),

  ttl: {
    live: num(process.env.CACHE_TTL_LIVE, 45),
    fixtures: num(process.env.CACHE_TTL_FIXTURES, 900),
    stats: num(process.env.CACHE_TTL_STATS, 43200),
    odds: num(process.env.CACHE_TTL_ODDS, 1800),
    prediction: num(process.env.CACHE_TTL_PREDICTION, 1800),
  },
};

export const SPORTS = ['football', 'basketball', 'hockey'];
