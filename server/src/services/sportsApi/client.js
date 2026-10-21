import { env } from '../../config/env.js';
import { KeyPool } from '../keyPool.js';
import { cached } from '../cache.js';
import { log } from '../../utils/logger.js';

export const sportsKeys = new KeyPool('sports', env.sports.keys, { cooldownMs: 30 * 60 * 1000 });

const HOSTS = {
  apisports: {
    football: 'https://v3.football.api-sports.io',
    basketball: 'https://v1.basketball.api-sports.io',
    hockey: 'https://v1.hockey.api-sports.io',
  },
  rapidapi: {
    football: 'https://api-football-v1.p.rapidapi.com/v3',
    basketball: 'https://api-basketball.p.rapidapi.com',
    hockey: 'https://api-hockey.p.rapidapi.com',
  },
};

const RAPID_HOSTS = {
  football: 'api-football-v1.p.rapidapi.com',
  basketball: 'api-basketball.p.rapidapi.com',
  hockey: 'api-hockey.p.rapidapi.com',
};

/** Per-sport daily call counter, for the dashboard (free tier = 100/day/sport). */
const usage = { day: null, football: 0, basketball: 0, hockey: 0 };
function countCall(sport) {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, football: 0, basketball: 0, hockey: 0 });
  usage[sport] = (usage[sport] || 0) + 1;
}
export const sportsUsage = () => ({ ...usage });

function headersFor(sport, key) {
  if (env.sports.provider === 'rapidapi') {
    return { 'x-rapidapi-key': key, 'x-rapidapi-host': RAPID_HOSTS[sport] };
  }
  return { 'x-apisports-key': key };
}

class QuotaError extends Error {}
export class SportsApiError extends Error {}

/**
 * The request will never succeed with this key because of the account's plan
 * (e.g. API-SPORTS free plans cannot read the current season, or the `last`
 * parameter). This is NOT quota exhaustion: the key is perfectly healthy for
 * other endpoints, so it must never be benched.
 */
export class PlanRestrictionError extends Error {
  constructor(message, { sport, pathname } = {}) {
    super(message);
    this.sport = sport;
    this.pathname = pathname;
  }
}

/**
 * Remembers endpoints this account is not entitled to, so we stop spending
 * requests on calls we know will fail. With a 100/day budget, re-discovering a
 * plan restriction on every prediction would waste most of the quota.
 */
const unavailable = new Map(); // capability -> { reason, until }
const UNAVAILABLE_TTL_MS = 6 * 3600 * 1000;

/**
 * A restriction applies to an endpoint *and the shape of the call*, not just the
 * path: `/fixtures?date=` is allowed on a free plan while `/fixtures?team=&last=`
 * is not, and both share a pathname. The season value is included too, since
 * entitlement is per season.
 */
export function capabilityKey(sport, pathname, params = {}) {
  const names = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k]) => k)
    .sort()
    .join(',');
  const season = params.season !== undefined && params.season !== null && params.season !== '' ? `&season=${params.season}` : '';
  return `${sport}:${pathname}?${names}${season}`;
}

export function markUnavailable(capability, reason) {
  unavailable.set(capability, { reason, until: Date.now() + UNAVAILABLE_TTL_MS });
  log.warn(`plan restriction: ${capability} — ${reason} (skipping for 6h to save quota)`);
}

export function checkUnavailable(capability) {
  const hit = unavailable.get(capability);
  if (!hit) return null;
  if (hit.until < Date.now()) {
    unavailable.delete(capability);
    return null;
  }
  return hit.reason;
}

export const planRestrictions = () =>
  [...unavailable.entries()]
    .filter(([, v]) => v.until > Date.now())
    .map(([k, v]) => ({ endpoint: k, reason: v.reason }));

/**
 * Classify an API-SPORTS `errors` payload. The provider answers HTTP 200 with
 * an errors object for everything from a dead key to a plan limit, so getting
 * this wrong is what previously benched healthy keys.
 */
function classifyErrors(errs) {
  if (!errs) return null;
  const entries = Array.isArray(errs)
    ? errs.map((v) => ['error', String(v)])
    : Object.entries(errs).map(([k, v]) => [k, String(v)]);
  if (!entries.length) return null;

  const text = entries.map(([k, v]) => `${k}: ${v}`).join('; ');
  const fields = entries.map(([k]) => k.toLowerCase());
  const body = entries.map(([, v]) => v).join(' ').toLowerCase();

  // dead or missing key
  if (fields.includes('token') || /missing application key|invalid api key|not subscribed/.test(body)) {
    return { kind: 'auth', text };
  }
  // genuine quota / rate limiting
  if (
    fields.includes('requests') ||
    fields.includes('ratelimit') ||
    /reached the request limit|request limit for the day|too many requests|exceeded.*(requests|quota)|rate limit/.test(body)
  ) {
    return { kind: 'quota', text };
  }
  // entitlement: the plan or the requested season/parameter is not included
  if (fields.includes('plan') || /do(es)? not have access|not available for your plan|upgrade your plan/.test(body)) {
    return { kind: 'plan', text };
  }
  // a required parameter we failed to send — our bug, not the key's
  return { kind: 'request', text };
}

/**
 * Raw GET against an API-SPORTS host, retried across every available key.
 * Quota / auth failures bench the key so later calls skip it.
 */
async function rawGet(sport, pathname, params) {
  const capability = capabilityKey(sport, pathname, params);
  const known = checkUnavailable(capability);
  if (known) throw new PlanRestrictionError(known, { sport, pathname, capability });

  const base = HOSTS[env.sports.provider]?.[sport] || HOSTS.apisports[sport];
  const url = new URL(base + pathname);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const candidates = sportsKeys.orderedCandidates();
  if (!candidates.length) {
    throw new SportsApiError(
      sportsKeys.size
        ? 'All sports API keys are rate-limited right now. Add more keys in SPORTS_API_KEYS or wait for the quota to reset.'
        : 'No sports API key configured. Set SPORTS_API_KEYS in server/.env (free at dashboard.api-football.com/register).'
    );
  }

  let lastError;
  for (const entry of candidates) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      sportsKeys.markUsed(entry);
      const res = await fetch(url, { headers: headersFor(sport, entry.key), signal: ac.signal });
      countCall(sport);

      if (res.status === 429) throw new QuotaError('HTTP 429 rate limit');
      if (res.status === 401 || res.status === 403) throw new QuotaError(`HTTP ${res.status} key rejected`);
      if (!res.ok) throw new SportsApiError(`${sport}${pathname} → HTTP ${res.status}`);

      const body = await res.json();

      // API-SPORTS answers 200 with an `errors` object for everything, so the
      // failure has to be classified rather than pattern-matched loosely.
      const problem = classifyErrors(body?.errors);
      if (problem) {
        if (problem.kind === 'quota') throw new QuotaError(problem.text);
        if (problem.kind === 'auth') throw new QuotaError(problem.text);
        if (problem.kind === 'plan') {
          // Remember it and move on — the key itself is fine.
          markUnavailable(capability, problem.text);
          throw new PlanRestrictionError(problem.text, { sport, pathname, capability });
        }
        throw new SportsApiError(problem.text);
      }
      return body;
    } catch (err) {
      lastError = err;
      if (err instanceof PlanRestrictionError) throw err; // another key won't help
      if (err instanceof QuotaError) {
        sportsKeys.bench(entry, err.message);
        continue; // try the next key
      }
      if (err.name === 'AbortError') {
        sportsKeys.noteError(entry, 'timeout');
        continue;
      }
      sportsKeys.noteError(entry, err.message);
      break; // a genuine API error won't be fixed by another key
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new SportsApiError(String(lastError));
}

/** Cached GET. `ttl` in seconds. */
export async function apiGet(sport, pathname, params, ttl) {
  const key = `sports:${sport}:${pathname}:${JSON.stringify(params || {})}`;
  const { data, cached: wasCached } = await cached(key, ttl, () => rawGet(sport, pathname, params));
  if (!wasCached) log.info(`sports/${sport}${pathname} ${JSON.stringify(params || {})}`);
  return data;
}
