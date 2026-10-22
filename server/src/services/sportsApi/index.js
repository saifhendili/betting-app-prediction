import * as football from './football.js';
import * as basketball from './basketball.js';
import * as hockey from './hockey.js';
import * as espn from './espn.js';
import { SPORTS, env } from '../../config/env.js';
import { sportsKeys, NoUsableKeyError } from './client.js';
import { log } from '../../utils/logger.js';

const apiSports = { football, basketball, hockey };

/**
 * Which feed serves listings right now.
 *
 * ESPN by default. API-SPORTS only when it is selected AND at least one key is
 * usable — a missing, exhausted or suspended key silently hands over to ESPN
 * instead of leaving the app with no games.
 */
export function resolveSource() {
  if (env.sports.dataSource === 'apisports' && sportsKeys.available().length > 0) return 'apisports';
  return 'espn';
}

/** Explains the effective source, for /api/health and the settings panel. */
export function describeSource() {
  const effective = resolveSource();
  const configured = env.sports.dataSource;
  return {
    configured,
    effective,
    fellBack: configured === 'apisports' && effective === 'espn',
    reason:
      configured === 'apisports' && effective === 'espn'
        ? sportsKeys.size
          ? 'No usable API-SPORTS key (exhausted, rate-limited or suspended) — using ESPN instead.'
          : 'No API-SPORTS key configured — using ESPN instead.'
        : null,
  };
}

let warnedFallback = false;

/**
 * Wrap an API-SPORTS adapter so a "no usable key" failure retries the same
 * call on ESPN. Plan restrictions and ordinary API errors still propagate —
 * only the failure another source can actually fix triggers the hand-over.
 */
function withEspnFallback(primary, sport) {
  const fallback = espn.forSport(sport);
  return new Proxy(primary, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function' || typeof fallback[prop] !== 'function') return fn;
      return async (...args) => {
        try {
          return await fn(...args);
        } catch (err) {
          if (!(err instanceof NoUsableKeyError)) throw err;
          if (!warnedFallback) {
            log.warn(`${err.message} Falling back to ESPN.`);
            warnedFallback = true;
          }
          return fallback[prop](...args);
        }
      };
    },
  });
}

/**
 * @param gameId  When given, route to the feed that issued this id — ESPN ids
 *   are namespaced (`nba.401585912`), API-SPORTS ids are plain numbers — so a
 *   prediction always talks to the source its game came from.
 */
export function adapter(sport, { gameId } = {}) {
  if (!apiSports[sport]) throw new Error(`Unsupported sport "${sport}". Use one of: ${SPORTS.join(', ')}`);
  if (gameId !== undefined && gameId !== null) {
    return espn.isEspnId(gameId) ? espn.forSport(sport) : apiSports[sport];
  }
  return resolveSource() === 'apisports' ? withEspnFallback(apiSports[sport], sport) : espn.forSport(sport);
}

export { football, basketball, hockey, SPORTS };
export {
  sportsKeys,
  sportsUsage,
  SportsApiError,
  PlanRestrictionError,
  NoUsableKeyError,
  planRestrictions,
} from './client.js';
