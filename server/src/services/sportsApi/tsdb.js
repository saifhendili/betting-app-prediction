import { makeGame } from './normalize.js';
import { SportsApiError } from './client.js';
import { canonicalLeague } from './espn.js';
import { cached } from '../cache.js';
import { env } from '../../config/env.js';
import { dayString } from '../../utils/time.js';
import { log } from '../../utils/logger.js';

/**
 * TheSportsDB — breadth, not prices.
 *
 * ESPN only tracks around 50 football leagues on a given day, and in
 * basketball and hockey just the NBA/WNBA/NCAA and NHL. TheSportsDB's live
 * feed covers far more: second divisions, Asia, Eastern Europe, the EuroLeague,
 * CBA, DEL, SHL, KHL feeder leagues. It carries no odds, so its games can be
 * watched live but only get a league-average prediction, and Suggested bets
 * skips them. It fills gaps; ESPN stays the source for anything it covers.
 *
 * Its "livescore" feed is really today's schedule plus live scores: football
 * lists only games in play, basketball and hockey list the whole day.
 */

const BASE = 'https://www.thesportsdb.com/api/v1/json';
const SPORT_NAME = { football: 'Soccer', basketball: 'Basketball', hockey: 'Ice Hockey' };

const LIVE = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'Q1', 'Q2', 'Q3', 'Q4', 'OT', 'P1', 'P2', 'P3', 'PT', 'LIVE', 'IN']);
const DONE = new Set(['FT', 'AET', 'PEN', 'AOT', 'AP', 'AW', 'AWD', 'WO', 'ABD', 'CANC', 'PST', 'POST', 'FIN', 'FINISHED']);

// A game still marked "in play" this long after kick-off is a stuck feed
// entry (one Russian VHL game sat at "P3" for a whole day), not a live game.
const MAX_LIVE_AGE_MIN = { football: 150, basketball: 200, hockey: 220 };

async function fetchJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (res.status === 429) throw new SportsApiError('TheSportsDB rate limit');
    if (!res.ok) throw new SportsApiError(`TheSportsDB ${res.status}`);
    const text = await res.text();
    // the free tier answers some calls with an HTML/plain notice instead of JSON
    try {
      return JSON.parse(text);
    } catch {
      throw new SportsApiError('TheSportsDB returned a non-JSON response');
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new SportsApiError('TheSportsDB timed out');
    throw err instanceof SportsApiError ? err : new SportsApiError(`TheSportsDB unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function liveFeed(sport) {
  const url = `${BASE}/${env.sports.tsdbKey}/livescore.php?s=${encodeURIComponent(SPORT_NAME[sport])}`;
  const { data, cached: hit } = await cached(`tsdb:live:${sport}`, 45, () => fetchJson(url));
  if (!hit) log.info(`tsdb/${sport} live feed → ${data?.livescore?.length ?? 0} entries`);
  return data?.livescore || [];
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** TheSportsDB timestamps are UTC without a zone suffix. */
const kickoffOf = (x) => {
  const ts = x.strTimestamp || (x.dateEvent && x.strEventTime ? `${x.dateEvent}T${x.strEventTime}` : null);
  if (!ts) return null;
  const iso = /Z|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function mapEvent(x, sport) {
  const short = String(x.strStatus || '').toUpperCase().trim() || 'NS';
  const kickoff = kickoffOf(x);
  const ageMin = kickoff ? (Date.now() - Date.parse(kickoff)) / 60000 : 0;

  let state = 'upcoming';
  if (DONE.has(short)) state = 'finished';
  else if (LIVE.has(short) || /^Q\d|^P\d|^\d+H$/.test(short)) state = ageMin > MAX_LIVE_AGE_MIN[sport] ? 'finished' : 'live';
  else if (short !== 'NS' && short !== 'TBD') state = 'upcoming';

  const progress = num(String(x.strProgress ?? '').match(/\d+/)?.[0]);
  const isFootball = sport === 'football';

  const alias = isFootball ? canonicalLeague(x.strLeague) : null;
  return makeGame({
    sport,
    source: 'tsdb',
    id: `tsdb.${x.idEvent}`,
    kickoff,
    statusShort: short,
    statusLong: state === 'live' ? 'In progress' : state === 'finished' ? 'Finished' : 'Not started',
    stateOverride: state,
    // football progress is the minute played; the other sports' meaning varies
    // by league, so the in-play model falls back to the period for those
    elapsed: state === 'live' && isFootball && progress !== null ? `${progress}'` : null,
    elapsedMinutes: state === 'live' && isFootball && progress !== null ? progress : null,
    league: {
      id: x.idLeague,
      name: alias?.name || x.strLeague || 'Unknown league',
      country: alias?.country || x.strCountry || null,
      logo: x.strLeagueBadge || null,
      season: x.strSeason || null,
    },
    home: { id: x.idHomeTeam, name: x.strHomeTeam, logo: x.strHomeTeamBadge || null },
    away: { id: x.idAwayTeam, name: x.strAwayTeam, logo: x.strAwayTeamBadge || null },
    scoreHome: state === 'upcoming' ? null : num(x.intHomeScore),
    scoreAway: state === 'upcoming' ? null : num(x.intAwayScore),
    hasOdds: false,
  });
}

export function forSport(sport) {
  if (!SPORT_NAME[sport]) throw new SportsApiError(`TheSportsDB has no feed for ${sport}`);

  const safeFeed = () =>
    liveFeed(sport).catch((err) => {
      log.warn(`tsdb/${sport}: ${err.message}`);
      return [];
    });

  return {
    source: 'tsdb',
    supportsLiveOdds: false,

    async listLive() {
      return (await safeFeed()).map((x) => mapEvent(x, sport)).filter((g) => g.state === 'live');
    },

    async listByDate(day) {
      return (await safeFeed())
        .map((x) => mapEvent(x, sport))
        .filter((g) => g.kickoff && dayString(new Date(g.kickoff)) === day);
    },

    async getGame(gameId) {
      const id = String(gameId).replace(/^tsdb\./, '');
      const hit = (await safeFeed()).find((x) => String(x.idEvent) === id);
      if (hit) return mapEvent(hit, sport);
      // gone from the live feed (finished, or not today): look it up directly
      const url = `${BASE}/${env.sports.tsdbKey}/lookupevent.php?id=${encodeURIComponent(id)}`;
      const { data } = await cached(`tsdb:event:${id}`, 60, () => fetchJson(url)).catch(() => ({ data: null }));
      const ev = data?.events?.[0];
      return ev ? mapEvent(ev, sport) : null;
    },

    async odds() {
      return [];
    },
    async teamStats() {
      return null;
    },
    async headToHead() {
      return [];
    },
    async recentGames() {
      return [];
    },
  };
}

export const isTsdbId = (id) => /^tsdb\.\d+$/.test(String(id));
