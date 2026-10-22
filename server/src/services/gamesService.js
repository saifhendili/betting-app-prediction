import { adapter, SPORTS } from './sportsApi/index.js';
import { sortGames, annotateTier } from './leagues.js';
import { dayString, todayString, tomorrowString } from '../utils/time.js';

/**
 * Time windows the UI offers. `hours` means "starting within the next N hours".
 * The horizon is deliberately capped at tomorrow — predictions decay fast and
 * the upstream free quota is small.
 */
export const WINDOWS = {
  live: { key: 'live', label: 'Live now', kind: 'live' },
  '1h': { key: '1h', label: 'Next 1 hour', kind: 'hours', hours: 1 },
  '3h': { key: '3h', label: 'Next 3 hours', kind: 'hours', hours: 3 },
  '6h': { key: '6h', label: 'Next 6 hours', kind: 'hours', hours: 6 },
  '12h': { key: '12h', label: 'Next 12 hours', kind: 'hours', hours: 12 },
  '24h': { key: '24h', label: 'Next 24 hours', kind: 'hours', hours: 24 },
  today: { key: 'today', label: 'Today', kind: 'day', day: 'today' },
  tomorrow: { key: 'tomorrow', label: 'Tomorrow', kind: 'day', day: 'tomorrow' },
  all: { key: 'all', label: 'Today + Tomorrow', kind: 'span' },
};

export const windowList = () => Object.values(WINDOWS).map(({ key, label }) => ({ key, label }));

/** Does an N-hour window from now spill past local midnight? */
function spansTomorrow(hours) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  return dayString(end) !== dayString(now);
}

async function fetchForWindow(api, win) {
  if (win.kind === 'live') return api.listLive();

  if (win.kind === 'day') {
    return api.listByDate(win.day === 'tomorrow' ? tomorrowString() : todayString());
  }

  if (win.kind === 'span') {
    const [a, b] = await Promise.all([api.listByDate(todayString()), api.listByDate(tomorrowString())]);
    return [...a, ...b];
  }

  // hours window
  const days = [api.listByDate(todayString())];
  if (spansTomorrow(win.hours)) days.push(api.listByDate(tomorrowString()));
  const results = await Promise.all(days);
  return results.flat();
}

function applyFilter(games, win, { includeFinished }) {
  if (win.kind === 'live') return games.filter((g) => g.state === 'live');

  if (win.kind === 'hours') {
    const limit = win.hours * 60;
    return games.filter((g) => g.state === 'upcoming' && g.startsInMinutes !== null && g.startsInMinutes >= -5 && g.startsInMinutes <= limit);
  }

  // day / span views show live + upcoming, and finished only if asked for
  return games.filter((g) => (includeFinished ? true : g.state !== 'finished'));
}

const dedupe = (games) => {
  const seen = new Set();
  return games.filter((g) => {
    if (seen.has(g.gameKey)) return false;
    seen.add(g.gameKey);
    return true;
  });
};

export async function listGames({ sport = 'football', window = 'today', includeFinished = false, league, limit = 120 }) {
  const win = WINDOWS[window] || WINDOWS.today;
  const sports = sport === 'all' ? SPORTS : [sport];

  const batches = await Promise.allSettled(
    sports.map(async (s) => {
      const api = adapter(s);
      const raw = await fetchForWindow(api, win);
      return applyFilter(raw, win, { includeFinished });
    })
  );

  const errors = [];
  let games = [];
  batches.forEach((b, i) => {
    if (b.status === 'fulfilled') games.push(...b.value);
    else errors.push({ sport: sports[i], message: b.reason?.message || String(b.reason) });
  });

  // every sport failed → surface the error rather than an empty list
  if (!games.length && errors.length === sports.length) {
    const err = new Error(errors.map((e) => `${e.sport}: ${e.message}`).join(' | '));
    err.status = 502;
    throw err;
  }

  games = dedupe(games);
  if (league) {
    const needle = String(league).toLowerCase();
    games = games.filter(
      (g) => g.league.name?.toLowerCase().includes(needle) || String(g.league.id) === String(league)
    );
  }

  const sorted = sortGames(annotateTier(games));
  const counts = {
    total: sorted.length,
    live: sorted.filter((g) => g.state === 'live').length,
    upcoming: sorted.filter((g) => g.state === 'upcoming').length,
    finished: sorted.filter((g) => g.state === 'finished').length,
  };

  return {
    window: { ...win, appliedAt: new Date().toISOString() },
    sport,
    counts,
    leagues: [...new Set(sorted.map((g) => g.league.name))].slice(0, 60),
    partialErrors: errors,
    games: sorted.slice(0, Math.min(Number(limit) || 120, 300)),
  };
}

export async function getGame({ sport, gameId }) {
  const game = await adapter(sport, { gameId }).getGame(gameId);
  if (!game) {
    const err = new Error(`No ${sport} game with id ${gameId}`);
    err.status = 404;
    throw err;
  }
  return annotateTier([game])[0];
}
