import { apiGet } from './client.js';
import { makeGame } from './normalize.js';
import { seasonCandidates } from './seasons.js';
import { env } from '../../config/env.js';

const SPORT = 'hockey';

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
    scoreHome: g.scores?.home ?? null,
    scoreAway: g.scores?.away ?? null,
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

export async function teamStats({ leagueId, season, teamId }) {
  for (const s of seasonCandidates(SPORT, season)) {
    const body = await apiGet(SPORT, '/teams/statistics', { league: leagueId, season: s, team: teamId }, env.ttl.stats);
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
        home: num(r.goals?.for?.average?.home),
        away: num(r.goals?.for?.average?.away),
        total: num(r.goals?.for?.average?.all),
      },
      conceded: {
        home: num(r.goals?.against?.average?.home),
        away: num(r.goals?.against?.average?.away),
        total: num(r.goals?.against?.average?.all),
      },
    };
  }
  return null;
}

export async function headToHead(homeId, awayId) {
  const body = await apiGet(SPORT, '/games/h2h', { h2h: `${homeId}-${awayId}`, timezone: env.timezone }, env.ttl.stats).catch(() => null);
  return (body?.response || [])
    .filter((g) => g.scores?.home != null)
    .slice(-6)
    .map((g) => ({
      date: g.date,
      league: g.league?.name,
      home: g.teams?.home?.name,
      away: g.teams?.away?.name,
      score: `${g.scores?.home}-${g.scores?.away}`,
      homeId: String(g.teams?.home?.id),
      goals: { home: g.scores?.home, away: g.scores?.away },
    }));
}

export async function recentGames(teamId, last = 6) {
  const body = await apiGet(SPORT, '/games', { team: teamId, timezone: env.timezone }, env.ttl.stats).catch(() => null);
  const rows = (body?.response || []).filter((g) => g.scores?.home != null).slice(-last);
  return rows.map((g) => {
    const isHome = String(g.teams?.home?.id) === String(teamId);
    return {
      date: g.date,
      isHome,
      scored: isHome ? g.scores.home : g.scores.away,
      conceded: isHome ? g.scores.away : g.scores.home,
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
