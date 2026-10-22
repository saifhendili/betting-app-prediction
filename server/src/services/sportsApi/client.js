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

/**
 * Client-side throttle.
 *
 * API-SPORTS allows 10 requests/MINUTE per key on the free plan (header
 * `x-ratelimit-limit`) on top of the 100/day cap. A burst — "best bets" running
 * several predictions at once — blows straight through it. Rather than get
 * refused and benched, requests wait for a slot. Each key has its own window,
 * so adding keys multiplies throughput as well as daily quota.
 */
const RATE_WINDOW_MS = 60_000;
const MAX_WAIT_MS = 30_000;

const windowHits = (entry) => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  entry.hits = (entry.hits || []).filter((t) => t > cutoff);
  return entry.hits;
};

const perMinuteLimit = (entry) => entry.rateLimitPerMin || env.sports.ratePerMinute;

function hasCapacity(entry) {
  return windowHits(entry).length < perMinuteLimit(entry);
}

function msUntilCapacity(entry) {
  const hits = windowHits(entry);
  const limit = perMinuteLimit(entry);
  if (hits.length < limit) return 0;
  const sorted = [...hits].sort((a, b) => a - b);
  return Math.max(sorted[hits.length - limit] + RATE_WINDOW_MS - Date.now() + 100, 0);
}

const noteHit = (entry) => {
  windowHits(entry).push(Date.now());
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record what the upstream says is left, so the dashboard can show the truth. */
function readQuotaHeaders(entry, res) {
  // A MISSING header must not read as zero. Number(null) === 0, so converting
  // blindly would treat any response without these headers as "no quota left"
  // and bench a perfectly healthy key.
  const header = (name) => {
    const raw = res.headers.get(name);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const perMin = header('x-ratelimit-limit');
  const dayLeft = header('x-ratelimit-requests-remaining');
  const dayLimit = header('x-ratelimit-requests-limit');

  if (perMin !== null && perMin > 0) entry.rateLimitPerMin = perMin;
  if (dayLeft !== null) entry.dayRemaining = dayLeft;
  if (dayLimit !== null) entry.dayLimit = dayLimit;

  // Nothing left today: stop trying until the upstream resets.
  if (dayLeft !== null && dayLeft <= 0) {
    sportsKeys.bench(entry, 'daily quota exhausted (0 requests remaining)', msUntilDailyReset());
  }
}

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

class QuotaError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Seconds until the next UTC midnight, when API-SPORTS resets daily counters. */
function msUntilDailyReset() {
  const now = new Date();
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0);
  return Math.min(Math.max(reset - now.getTime(), 60_000), 12 * 3600 * 1000);
}
export class SportsApiError extends Error {}

/**
 * Every configured key is benched, missing or dead. Distinct from a normal API
 * error because it is the one failure another data source can fix — the
 * adapter registry catches it and falls back to ESPN.
 */
export class NoUsableKeyError extends SportsApiError {}

function describeUnusableKeys() {
  if (!sportsKeys.size) return 'No API-SPORTS key configured.';
  const reasons = [...new Set(sportsKeys.keys.map((k) => k.lastError).filter(Boolean))];
  return `No usable API-SPORTS key${reasons.length ? `: ${reasons.join('; ')}` : ' (all rate-limited)'}.`;
}

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

  // dead, missing or SUSPENDED key. Previously a suspended account fell through
  // to "request error", so the key was never benched and every call kept
  // hitting it.
  if (fields.includes('access') || /suspend|banned|blocked|deactivat|disabled/.test(body)) {
    return { kind: 'auth', text: 'API-SPORTS account suspended — see dashboard.api-football.com' };
  }
  if (fields.includes('token') || /missing application key|invalid api key|not subscribed/.test(body)) {
    return { kind: 'auth', text };
  }
  // A per-MINUTE rate limit is not exhaustion — the key works again in seconds.
  // Benching it for half an hour (as a daily limit deserves) is what previously
  // made a burst of predictions report "all keys rate-limited".
  if (fields.includes('ratelimit') || /per minute|rate limit|too many requests/.test(body)) {
    return { kind: 'rate', text };
  }
  // Daily quota genuinely gone until the upstream reset.
  if (
    fields.includes('requests') ||
    /reached the request limit|request limit for the day|daily|exceeded.*(requests|quota)/.test(body)
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
  if (!candidates.length) throw new NoUsableKeyError(describeUnusableKeys());

  let lastError;
  for (const entry of candidates) {
    // Prefer a key with a free slot; otherwise wait for the soonest one.
    if (!hasCapacity(entry)) {
      const alternative = candidates.find((c) => c !== entry && hasCapacity(c));
      if (alternative) continue; // another key can serve this now
      const wait = Math.min(msUntilCapacity(entry), MAX_WAIT_MS);
      if (wait > 0) {
        log.info(`throttling ${entry.label} for ${Math.ceil(wait / 1000)}s (${perMinuteLimit(entry)}/min cap)`);
        await sleep(wait);
      }
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      sportsKeys.markUsed(entry);
      noteHit(entry);
      const res = await fetch(url, { headers: headersFor(sport, entry.key), signal: ac.signal });
      countCall(sport);
      readQuotaHeaders(entry, res);

      if (res.status === 429) throw new QuotaError('HTTP 429 rate limit', 65_000);
      if (res.status === 401 || res.status === 403) {
        throw new QuotaError(`HTTP ${res.status} key rejected`, 6 * 3600 * 1000);
      }
      if (!res.ok) throw new SportsApiError(`${sport}${pathname} → HTTP ${res.status}`);

      const body = await res.json();

      // API-SPORTS answers 200 with an `errors` object for everything, so the
      // failure has to be classified rather than pattern-matched loosely.
      const problem = classifyErrors(body?.errors);
      if (problem) {
        if (problem.kind === 'rate') throw new QuotaError(problem.text, 65_000);
        if (problem.kind === 'quota') throw new QuotaError(problem.text, msUntilDailyReset());
        if (problem.kind === 'auth') throw new QuotaError(problem.text, 6 * 3600 * 1000);
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
        sportsKeys.bench(entry, err.message, err.retryAfterMs);
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
  // Every key we tried was benched on the way through.
  if (lastError instanceof QuotaError) throw new NoUsableKeyError(describeUnusableKeys());
  throw lastError instanceof Error ? lastError : new SportsApiError(String(lastError));
}

/** Cached GET. `ttl` in seconds. */
export async function apiGet(sport, pathname, params, ttl) {
  const key = `sports:${sport}:${pathname}:${JSON.stringify(params || {})}`;
  const { data, cached: wasCached } = await cached(key, ttl, () => rawGet(sport, pathname, params));
  if (!wasCached) log.info(`sports/${sport}${pathname} ${JSON.stringify(params || {})}`);
  return data;
}
