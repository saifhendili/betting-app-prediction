import { apiGet } from './client.js';
import { makeGame } from './normalize.js';
import { seasonCandidates } from './seasons.js';
import { env } from '../../config/env.js';

const SPORT = 'basketball';

const mapGame = (g) =>
  makeGame({
    sport: SPORT,
    id: g.id,
    kickoff: g.date,
    statusShort: g.status?.short,
    statusLong: g.status?.long,
    elapsed: g.status?.timer ?? null,
    league: { id: g.league?.id, name: g.league?.name, country: g.country?.name || g.league?.country?.name, logo: g.league?.logo, season: g.league?.season },
    round: g.stage || null,
    home: g.teams?.home,
    away: g.teams?.away,
    scoreHome: g.scores?.home?.total ?? null,
    scoreAway: g.scores?.away?.total ?? null,
  });

export async function listByDate(day) {
  const body = await apiGet(SPORT, '/games', { date: day, timezone: env.timezone }, env.ttl.fixtures);
  return (body?.response || []).map(mapGame);
}

export async function listLive() {
  const body = await apiGet(SPORT, '/games', { live: 'all', timezone: env.timezone }, env.ttl.live);
  return (body?.response || []).map(mapGame);
}

export async function getGame(id) {
  const body = await apiGet(SPORT, '/games', { id, timezone: env.timezone }, env.ttl.live);
  const first = body?.response?.[0];
  return first ? mapGame(first) : null;
}

/** Points scored / conceded per game, split home vs away. */
export async function teamStats({ leagueId, season, teamId }) {
  for (const s of seasonCandidates(SPORT, season)) {
    const body = await apiGet(SPORT, '/statistics', { league: leagueId, season: s, team: teamId }, env.ttl.stats);
    const r = body?.response;
    const played = r?.games?.played?.all ?? 0;
    if (!r || !played) continue;
    return {
      season: s,
      form: null,
      played: { home: r.games.played.home || 0, away: r.games.played.away || 0, total: played },
      wins: {
        home: r.games.wins?.home?.total || 0,
        away: r.games.wins?.away?.total || 0,
        total: r.games.wins?.all?.total || 0,
      },
      draws: { total: 0 },
      losses: { total: r.games.loses?.all?.total || 0 },
      scored: {
        home: num(r.points?.for?.average?.home),
        away: num(r.points?.for?.average?.away),
        total: num(r.points?.for?.average?.all),
      },
      conceded: {
        home: num(r.points?.against?.average?.home),
        away: num(r.points?.against?.average?.away),
        total: num(r.points?.against?.average?.all),
      },
    };
  }
  return null;
}

export async function headToHead(homeId, awayId) {
  const body = await apiGet(SPORT, '/games', { h2h: `${homeId}-${awayId}`, timezone: env.timezone }, env.ttl.stats);
  return (body?.response || [])
    .filter((g) => g.scores?.home?.total != null)
    .slice(-6)
    .map((g) => ({
      date: g.date,
      league: g.league?.name,
      home: g.teams?.home?.name,
      away: g.teams?.away?.name,
      score: `${g.scores?.home?.total}-${g.scores?.away?.total}`,
      homeId: String(g.teams?.home?.id),
      goals: { home: g.scores?.home?.total, away: g.scores?.away?.total },
    }));
}

export async function recentGames(teamId, last = 6) {
  // Basketball has no `last=` param, so pull the team's season games and tail them.
  const body = await apiGet(SPORT, '/games', { team: teamId, season: undefined, timezone: env.timezone }, env.ttl.stats).catch(() => null);
  const rows = (body?.response || [])
    .filter((g) => g.scores?.home?.total != null)
    .slice(-last);
  return rows.map((g) => {
    const isHome = String(g.teams?.home?.id) === String(teamId);
    return {
      date: g.date,
      isHome,
      scored: isHome ? g.scores.home.total : g.scores.away.total,
      conceded: isHome ? g.scores.away.total : g.scores.home.total,
      opponent: isHome ? g.teams?.away?.name : g.teams?.home?.name,
    };
  });
}

export async function odds(gameId) {
  const body = await apiGet(SPORT, '/odds', { game: gameId }, env.ttl.odds);
  return body?.response || [];
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
