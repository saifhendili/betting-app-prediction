import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { describeSettings, saveSettings, testKeys } from '../services/settingsService.js';
import { env } from '../config/env.js';

export const settingsRouter = Router();

/**
 * Guards the endpoints that can change keys or spend upstream calls.
 *
 * Reading settings is open — it only ever returns masked keys, and the UI needs
 * it to render. Writing is not: on a hosted instance anyone with the URL could
 * otherwise replace your keys or burn your daily quota. Set ADMIN_TOKEN to
 * require a token; leave it unset for a local-only instance.
 */
function requireAdmin(req, res, next) {
  if (!env.adminToken) return next();
  const supplied = req.get('x-admin-token') || '';
  if (supplied && timingSafeEqual(supplied, env.adminToken)) return next();
  return res.status(401).json({
    error: 'This instance requires an admin token to change settings.',
    needsToken: true,
  });
}

/** Constant-time compare so the token can't be guessed byte-by-byte. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Validation hits the upstream providers, so it gets its own tighter budget.
const testLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false });

settingsRouter.get('/', (_req, res) =>
  res.json({ ...describeSettings(), requiresToken: Boolean(env.adminToken) })
);

settingsRouter.put('/', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};

    // Only forward the fields actually supplied, so saving Gemini keys never
    // clears the sports keys.
    for (const field of ['geminiKeys', 'sportsKeys']) {
      if (field in body) {
        const value = body[field];
        if (!Array.isArray(value) && typeof value !== 'string') {
          const err = new Error(`${field} must be an array of keys or a comma-separated string`);
          err.status = 400;
          throw err;
        }
        patch[field] = value;
      }
    }
    for (const field of ['geminiModel', 'sportsProvider', 'marketWeight', 'enableOdds']) {
      if (field in body) patch[field] = body[field];
    }

    if (!Object.keys(patch).length) {
      const err = new Error('Nothing to update.');
      err.status = 400;
      throw err;
    }

    const { persisted } = await saveSettings(patch);
    res.json({
      saved: true,
      persisted,
      requiresToken: Boolean(env.adminToken),
      warning: persisted ? null : 'MongoDB is offline — these settings are active now but will be lost on restart.',
      settings: describeSettings(),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/test', requireAdmin, testLimiter, async (req, res, next) => {
  try {
    const { geminiKeys, sportsKeys } = req.body || {};
    res.json(await testKeys({ geminiKeys, sportsKeys }));
  } catch (err) {
    next(err);
  }
});
