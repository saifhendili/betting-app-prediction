import { makeGame } from './normalize.js';
import { SportsApiError } from './client.js';
import { cached } from '../cache.js';
import { env } from '../../config/env.js';
import { dayString } from '../../utils/time.js';
import { log } from '../../utils/logger.js';

/**
 * ESPN public scoreboard adapter.
 *
 * No key and no quota, and every fixture carries DraftKings odds — moneyline
 * (with the draw for football), spread and total — including the opening,
 * closing and current in-play price. That makes it a better free source for
 * this app than API-SPORTS' free plan, which exposed no current-season team
 * data and no in-play odds.
 *
 * Caveat: it is ESPN's site API, not a documented public product. It has been
 * stable for years, but it can change without notice.
 *
 * Game ids are namespaced `<feed>.<eventId>` (e.g. `nba.401585912`) so any id
 * can be routed back to the right feed, and can never collide with a numeric
 * API-SPORTS id.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const FEEDS = {
  football: [{ key: 'soccer', path: 'soccer/all', kind: 'soccer', query: { limit: 500 } }],
  basketball: [
    { key: 'nba', path: 'basketball/nba', kind: 'basketball', periods: 4, periodLen: 12, league: { name: 'NBA', country: 'USA' } },
    { key: 'wnba', path: 'basketball/wnba', kind: 'basketball', periods: 4, periodLen: 10, league: { name: 'WNBA', country: 'USA' } },
    {
      key: 'ncaam',
      path: 'basketball/mens-college-basketball',
      kind: 'basketball',
      periods: 2,
      periodLen: 20,
      query: { groups: 50, limit: 500 },
      league: { name: 'NCAAM', country: 'USA' },
    },
  ],
  hockey: [{ key: 'nhl', path: 'hockey/nhl', kind: 'hockey', periods: 3, periodLen: 20, league: { name: 'NHL', country: 'USA' } }],
};

const FEED_BY_KEY = Object.fromEntries(
  Object.entries(FEEDS).flatMap(([sport, feeds]) => feeds.map((f) => [f.key, { ...f, sport }]))
);

/** ESPN football league slugs → the names/countries the tiering expects. */
const SOCCER_LEAGUES = {
  'eng.1': ['Premier League', 'England'],
  'esp.1': ['La Liga', 'Spain'],
  'ita.1': ['Serie A', 'Italy'],
  'ger.1': ['Bundesliga', 'Germany'],
  'fra.1': ['Ligue 1', 'France'],
  'uefa.champions': ['UEFA Champions League', 'World'],
  'uefa.europa': ['UEFA Europa League', 'World'],
  'uefa.europa.conf': ['UEFA Europa Conference League', 'World'],
  'uefa.nations': ['UEFA Nations League', 'World'],
  'fifa.world': ['World Cup', 'World'],
  'conmebol.libertadores': ['Copa Libertadores', 'World'],
  'conmebol.sudamericana': ['Copa Sudamericana', 'World'],
  'ned.1': ['Eredivisie', 'Netherlands'],
  'por.1': ['Primeira Liga', 'Portugal'],
  'eng.2': ['Championship', 'England'],
  'eng.3': ['League One', 'England'],
  'eng.4': ['League Two', 'England'],
  'sco.1': ['Premiership', 'Scotland'],
  'tur.1': ['Super Lig', 'Turkey'],
  'bel.1': ['Pro League', 'Belgium'],
  'usa.1': ['Major League Soccer', 'USA'],
  'mex.1': ['Liga MX', 'Mexico'],
  'bra.1': ['Serie A', 'Brazil'],
  'arg.1': ['Primera División', 'Argentina'],
  'ksa.1': ['Saudi Pro League', 'Saudi Arabia'],
  'ger.2': ['2. Bundesliga', 'Germany'],
  'ita.2': ['Serie B', 'Italy'],
  'fra.2': ['Ligue 2', 'France'],
  'esp.2': ['Segunda División', 'Spain'],
  'eng.fa': ['FA Cup', 'England'],
  'esp.copa_del_rey': ['Copa del Rey', 'Spain'],
  'ita.coppa_italia': ['Coppa Italia', 'Italy'],
  'ger.dfb_pokal': ['DFB Pokal', 'Germany'],
};

/**
 * Most football events carry no league slug, only a display name like
 * "English Premier League" or "EFL Championship". Normalise those to the
 * names/countries the tiering understands, so the big leagues sort first.
 */
const SOCCER_ALIASES = [
  [/^english premier league$/i, 'Premier League', 'England'],
  [/^(spanish )?la ?liga( ea sports)?$/i, 'La Liga', 'Spain'],
  [/^(italian )?serie a$/i, 'Serie A', 'Italy'],
  [/^(german )?bundesliga$/i, 'Bundesliga', 'Germany'],
  [/^(french )?ligue 1$/i, 'Ligue 1', 'France'],
  [/^uefa champions league$/i, 'UEFA Champions League', 'World'],
  [/^uefa europa league$/i, 'UEFA Europa League', 'World'],
  [/^uefa (europa )?conference league$/i, 'UEFA Europa Conference League', 'World'],
  [/^(efl )?championship$/i, 'Championship', 'England'],
  [/^efl league one$/i, 'League One', 'England'],
  [/^efl league two$/i, 'League Two', 'England'],
  [/^brazil(ian)? serie a$/i, 'Serie A', 'Brazil'],
  [/^(mls|major league soccer)$/i, 'Major League Soccer', 'USA'],
  [/^(dutch )?eredivisie$/i, 'Eredivisie', 'Netherlands'],
  [/^(portuguese )?(primeira liga|liga portugal)$/i, 'Primeira Liga', 'Portugal'],
  [/^(scottish )?premiership$/i, 'Premiership', 'Scotland'],
  [/^(turkish )?s(ü|u)per lig$/i, 'Super Lig', 'Turkey'],
  [/^(belgian )?(jupiler )?pro league$/i, 'Pro League', 'Belgium'],
  [/^(mexican )?liga mx$/i, 'Liga MX', 'Mexico'],
  [/^(italian )?serie b$/i, 'Serie B', 'Italy'],
  [/^(german )?2\. bundesliga$/i, '2. Bundesliga', 'Germany'],
  [/^(french )?ligue 2$/i, 'Ligue 2', 'France'],
  [/^(spanish )?(laliga 2|segunda)/i, 'Segunda División', 'Spain'],
  [/^(saudi )?(pro league|saudi pro league)$/i, 'Saudi Pro League', 'Saudi Arabia'],
  [/libertadores/i, 'Copa Libertadores', 'World'],
  [/sudamericana/i, 'Copa Sudamericana', 'World'],
];

export function canonicalLeague(name) {
  const hit = SOCCER_ALIASES.find(([re]) => re.test(String(name || '').trim()));
  return hit ? { name: hit[1], country: hit[2] } : null;
}

// ── fetching ────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new SportsApiError(`ESPN ${res.status} for ${url.pathname}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new SportsApiError('ESPN timed out');
    throw err instanceof SportsApiError ? err : new SportsApiError(`ESPN unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * One scoreboard. `date` is a YYYYMMDD string, or null for ESPN's "current"
 * board, which is what carries the games in progress right now.
 */
async function scoreboard(feed, date) {
  const url = new URL(`${BASE}/${feed.path}/scoreboard`);
  Object.entries(feed.query || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  if (date) url.searchParams.set('dates', date);

  // Near-term boards hold live scores, so they refresh often; ESPN has no
  // quota, but there is no reason to hammer it either.
  const near = !date || Math.abs(Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`) - Date.now()) < 2 * 86400e3;
  const ttl = !date ? 30 : near ? 60 : env.ttl.fixtures;

  const key = `espn:${feed.path}:${date || 'current'}:${JSON.stringify(feed.query || {})}`;
  const { data, cached: hit } = await cached(key, ttl, () => fetchJson(url));
  if (!hit) log.info(`espn/${feed.path} ${date || 'current'} → ${data?.events?.length ?? 0} events`);
  return data || { events: [] };
}

// ── mapping ─────────────────────────────────────────────────────────────────

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function soccerLeague(ev) {
  const comp = ev.competitions?.[0] || {};
  const slug = (ev.links || [])
    .map((l) => String(l.href || '').match(/\/league\/([a-z0-9._-]+)/i)?.[1])
    .find(Boolean);
  const leagueId = String(ev.uid || '').match(/l:(\d+)/)?.[1] || null;
  const known = slug && SOCCER_LEAGUES[slug];
  // altGameNote reads "CONMEBOL Libertadores, Semifinals" — the competition
  // comes first, the round after.
  const [fromNote, ...roundParts] = String(comp.altGameNote || '').split(', ');
  const alias = !known && canonicalLeague(fromNote);
  return {
    id: leagueId || slug,
    name: known?.[0] || alias?.name || fromNote || prettySlug(slug) || 'Football',
    country: known?.[1] || alias?.country || null,
    // ESPN's event league ids don't map onto its logo paths, so a guessed URL
    // 404s more often than not — the UI shows the sport icon instead.
    logo: null,
    season: ev.season?.year ?? null,
    round: roundParts.join(', ') || ev.season?.slug || null,
  };
}

const prettySlug = (slug) =>
  slug
    ? slug
        .split('.')
        .map((p) => p.toUpperCase())
        .join(' ')
    : null;

/**
 * ESPN states are pre / in / post. The status codes below are mapped onto the
 * ones the UI and the in-play model already understand, and the exact minutes
 * played are computed so the live model never has to guess from the phase.
 */
function mapStatus(feed, status) {
  const type = status?.type || {};
  const state = type.state;
  const period = Number(status?.period) || 0;
  const clock = Number(status?.clock) || 0;
  const name = String(type.name || '');

  if (state === 'pre') {
    if (/POSTPONED/.test(name)) return { state: 'finished', short: 'PST', long: 'Postponed' };
    if (/CANCELED|CANCELLED/.test(name)) return { state: 'finished', short: 'CANC', long: 'Cancelled' };
    return { state: 'upcoming', short: 'NS', long: type.description || 'Scheduled' };
  }

  if (state === 'post') {
    const detail = String(type.shortDetail || type.detail || '');
    let short = 'FT';
    if (/pen|pk|so\b|shootout/i.test(detail)) short = feed.kind === 'hockey' ? 'AP' : 'PEN';
    else if (/aet|ot|extra/i.test(detail)) short = feed.kind === 'soccer' ? 'AET' : 'AOT';
    if (/POSTPONED/.test(name)) short = 'PST';
    if (/CANCELED|CANCELLED|ABANDONED/.test(name)) short = 'CANC';
    return { state: 'finished', short, long: type.description || 'Final' };
  }

  // in progress
  const display = status?.displayClock || null;

  if (feed.kind === 'soccer') {
    // football clocks count UP, in seconds
    let short = period <= 1 ? '1H' : period === 2 ? '2H' : period <= 4 ? 'ET' : 'P';
    if (/HALFTIME/.test(name)) short = 'HT';
    const minutes = /HALFTIME/.test(name) ? 45 : clock / 60;
    return { state: 'live', short, long: type.description || 'In progress', display, elapsedMinutes: minutes };
  }

  // basketball and hockey clocks count DOWN within a period, in seconds
  const { periods, periodLen } = feed;
  const full = periods * periodLen;
  let played;
  if (/HALFTIME/.test(name)) played = full / 2;
  else if (period > periods) played = full;
  else played = (Math.max(period, 1) - 1) * periodLen + (periodLen - Math.min(clock / 60, periodLen));

  let short;
  if (feed.kind === 'hockey') {
    short = period > periods + 1 ? 'SO' : period > periods ? 'OT' : `P${Math.max(period, 1)}`;
    if (/END_PERIOD|INTERMISSION/.test(name)) short = 'BT';
  } else {
    short = period > periods ? 'OT' : periods === 2 ? `H${Math.max(period, 1)}` : `Q${Math.max(period, 1)}`;
    if (/HALFTIME/.test(name)) short = 'HT';
  }

  // the in-play model works on a fixed regulation clock per sport (48 / 60),
  // so express progress on that scale whatever this league's period length is
  const scale = feed.kind === 'hockey' ? 60 : 48;
  return {
    state: 'live',
    short,
    long: type.description || 'In progress',
    display: display && short !== 'HT' && short !== 'BT' ? display : null,
    elapsedMinutes: (played / full) * scale,
  };
}

function mapEvent(ev, feed, top) {
  const comp = ev.competitions?.[0] || {};
  const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
  const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
  const st = mapStatus(feed, ev.status || comp.status);

  let league;
  if (feed.kind === 'soccer') {
    league = soccerLeague(ev);
  } else {
    const l = top?.leagues?.[0] || {};
    league = {
      id: feed.key,
      name: feed.league.name,
      country: feed.league.country,
      logo: l.logos?.[0]?.href || null,
      season: ev.season?.year ?? l.season?.year ?? null,
      round: comp.notes?.[0]?.headline || null,
    };
  }

  const team = (c) => ({
    id: c?.team?.id ?? null,
    name: c?.team?.displayName || c?.team?.name || null,
    logo: c?.team?.logo || null,
  });

  return makeGame({
    sport: feed.sport,
    source: 'espn',
    id: `${feed.key}.${ev.id}`,
    kickoff: ev.date,
    statusShort: st.short,
    statusLong: st.long,
    elapsed: st.display ?? null,
    elapsedMinutes: st.elapsedMinutes ?? null,
    stateOverride: st.state,
    league,
    round: league.round,
    home: team(home),
    away: team(away),
    scoreHome: st.state === 'upcoming' ? null : num(home?.score),
    scoreAway: st.state === 'upcoming' ? null : num(away?.score),
    venue: comp.venue?.fullName || null,
    // ESPN sends `odds: [null]` for fixtures DraftKings doesn't price (minor
    // leagues, friendlies) — those can only get a league-average prediction.
    hasOdds: Boolean(comp.odds?.[0]),
  });
}

// ── odds ────────────────────────────────────────────────────────────────────

/** American odds ("+125", "-120", "EVEN") → decimal. "OFF" and blanks → null. */
export function americanToDecimal(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim().toUpperCase();
  if (!t || t === 'OFF' || t === '-' || t === 'N/A') return null;
  if (t === 'EVEN' || t === 'EV') return 2;
  const n = Number(t.replace('+', ''));
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) < 100) return null;
  const dec = n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  return Math.round(dec * 1000) / 1000;
}

const parseLine = (raw) => {
  const m = String(raw ?? '').match(/[+-]?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/**
 * Convert ESPN's DraftKings block into the API-SPORTS bookmaker shape, so the
 * existing parser, de-vigging and model fit are reused untouched.
 *
 * `snapshot`:
 *   'prematch' — the price before kick-off (current → close → open for an
 *                upcoming game, close → open for one already under way). The
 *                model's team strength is fitted to this.
 *   'current'  — the live in-play price, only meaningful while the game is on.
 *
 * Every market takes all of its sides from the SAME snapshot, so an over is
 * never paired with an under quoted at a different moment.
 */
export function espnOddsToBookmakers(ev, sport, { snapshot = 'prematch', live = false } = {}) {
  const o = ev.competitions?.[0]?.odds?.[0];
  if (!o) return [];

  const order = snapshot === 'current' ? ['current'] : live ? ['close', 'open'] : ['current', 'close', 'open'];
  const football = sport === 'football';
  const bets = [];

  // moneyline (three-way for football)
  const ml = o.moneyline;
  if (ml) {
    for (const snap of order) {
      const h = americanToDecimal(ml.home?.[snap]?.odds);
      const a = americanToDecimal(ml.away?.[snap]?.odds);
      const d = football ? americanToDecimal(ml.draw?.[snap]?.odds) : null;
      if (h && a && (!football || d)) {
        bets.push({
          name: football ? 'Match Winner' : 'Home/Away',
          values: [
            { value: 'Home', odd: h },
            ...(football ? [{ value: 'Draw', odd: d }] : []),
            { value: 'Away', odd: a },
          ],
        });
        break;
      }
    }
  } else if (snapshot === 'prematch') {
    // older flat format
    const h = americanToDecimal(o.homeTeamOdds?.moneyLine);
    const a = americanToDecimal(o.awayTeamOdds?.moneyLine);
    const d = americanToDecimal(o.drawOdds?.moneyLine);
    if (h && a && (!football || d)) {
      bets.push({
        name: football ? 'Match Winner' : 'Home/Away',
        values: [{ value: 'Home', odd: h }, ...(football ? [{ value: 'Draw', odd: d }] : []), { value: 'Away', odd: a }],
      });
    }
  }

  // total
  const tot = o.total;
  if (tot) {
    for (const snap of order) {
      const ol = parseLine(tot.over?.[snap]?.line);
      const ul = parseLine(tot.under?.[snap]?.line);
      const oo = americanToDecimal(tot.over?.[snap]?.odds);
      const uo = americanToDecimal(tot.under?.[snap]?.odds);
      if (ol !== null && ol === ul && oo && uo) {
        bets.push({
          name: football ? 'Goals Over/Under' : 'Over/Under',
          values: [
            { value: `Over ${ol}`, odd: oo },
            { value: `Under ${ul}`, odd: uo },
          ],
        });
        break;
      }
    }
  }

  // spread / handicap
  const sp = o.pointSpread;
  if (sp) {
    for (const snap of order) {
      const hl = parseLine(sp.home?.[snap]?.line);
      const al = parseLine(sp.away?.[snap]?.line);
      const ho = americanToDecimal(sp.home?.[snap]?.odds);
      const ao = americanToDecimal(sp.away?.[snap]?.odds);
      if (hl !== null && al !== null && Math.abs(hl + al) < 1e-9 && ho && ao) {
        bets.push({
          name: football ? 'Asian Handicap' : 'Handicap',
          values: [
            { value: `Home ${signed(hl)}`, odd: ho },
            { value: `Away ${signed(al)}`, odd: ao },
          ],
        });
        break;
      }
    }
  }

  if (!bets.length) return [];
  return [{ bookmakers: [{ id: 'espn', name: o.provider?.name || 'DraftKings', bets }] }];
}

// ── adapter interface ───────────────────────────────────────────────────────

/** ET-ish calendar dates bracketing a local day, so late kick-offs are caught. */
function datesCovering(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const prev = new Date(d.getTime() - 86400e3);
  return [ymd(prev), ymd(d)];
}

async function eventsFor(sport, dates) {
  const feeds = FEEDS[sport] || [];
  const boards = await Promise.all(
    feeds.flatMap((feed) =>
      dates.map((date) =>
        scoreboard(feed, date)
          .then((top) => ({ feed, top }))
          .catch((err) => {
            log.warn(`espn/${feed.path} ${date || 'current'} failed: ${err.message}`);
            return { feed, top: { events: [] } };
          })
      )
    )
  );
  const seen = new Set();
  const out = [];
  boards.forEach(({ feed, top }) =>
    (top.events || []).forEach((ev) => {
      const id = `${feed.key}.${ev.id}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ feed: { ...feed, sport }, top, ev });
    })
  );
  return out;
}

export function forSport(sport) {
  if (!FEEDS[sport]) throw new SportsApiError(`ESPN has no feed for ${sport}`);

  /** Find one raw event by namespaced id across the boards likely to hold it. */
  async function locate(gameId) {
    const [key, eventId] = String(gameId).split('.');
    const feed = FEED_BY_KEY[key];
    if (!feed || feed.sport !== sport || !eventId) return null;
    const today = new Date();
    const dates = [null, ...[-1, 0, 1, 2].map((o) => ymd(new Date(today.getTime() + o * 86400e3)))];
    for (const date of dates) {
      const top = await scoreboard(feed, date).catch(() => null);
      const ev = top?.events?.find((e) => String(e.id) === eventId);
      if (ev) return { feed: { ...feed, sport }, top, ev };
    }
    return null;
  }

  return {
    source: 'espn',
    supportsLiveOdds: true,

    async listByDate(day) {
      const rows = await eventsFor(sport, datesCovering(day));
      return rows
        .map(({ feed, top, ev }) => mapEvent(ev, feed, top))
        .filter((g) => g.kickoff && dayString(new Date(g.kickoff)) === day);
    },

    async listLive() {
      // ESPN's undated board is its notion of "now", including late games
      const rows = await eventsFor(sport, [null]);
      return rows.map(({ feed, top, ev }) => mapEvent(ev, feed, top)).filter((g) => g.state === 'live');
    },

    async getGame(gameId) {
      const hit = await locate(gameId);
      return hit ? mapEvent(hit.ev, hit.feed, hit.top) : null;
    },

    async odds(gameId, { snapshot = 'prematch' } = {}) {
      const hit = await locate(gameId);
      if (!hit) return [];
      const live = hit.ev.status?.type?.state === 'in';
      if (snapshot === 'current' && !live) return [];
      return espnOddsToBookmakers(hit.ev, sport, { snapshot, live });
    },

    // The free scoreboard carries no season statistics or head-to-head; the
    // model is fitted to the odds instead (see services/model/marketFit.js).
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

export const isEspnId = (id) => /^[a-z]+\.\d+$/.test(String(id));
