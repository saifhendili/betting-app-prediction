import { apiGet } from './client.js';
import { makeGame } from './normalize.js';
import { seasonCandidates } from './seasons.js';
import { env } from '../../config/env.js';

const SPORT = 'football';

const mapFixture = (f) =>
  makeGame({
    sport: SPORT,
    id: f.fixture?.id,
    kickoff: f.fixture?.date,
    statusShort: f.fixture?.status?.short,
    statusLong: f.fixture?.status?.long,
    elapsed: f.fixture?.status?.elapsed ?? null,
    league: { id: f.league?.id, name: f.league?.name, country: f.league?.country, logo: f.league?.logo, season: f.league?.season },
    round: f.league?.round,
    home: f.teams?.home,
    away: f.teams?.away,
    scoreHome: f.goals?.home ?? null,
    scoreAway: f.goals?.away ?? null,
    venue: f.fixture?.venue?.name || null,
  });

export async function listByDate(day) {
  const body = await apiGet(SPORT, '/fixtures', { date: day, timezone: env.timezone }, env.ttl.fixtures);
  return (body?.response || []).map(mapFixture);
}

export async function listLive() {
  const body = await apiGet(SPORT, '/fixtures', { live: 'all', timezone: env.timezone }, env.ttl.live);
  return (body?.response || []).map(mapFixture);
}

export async function getGame(id) {
  const body = await apiGet(SPORT, '/fixtures', { id, timezone: env.timezone }, env.ttl.live);
  const first = body?.response?.[0];
  return first ? mapFixture(first) : null;
}

/** Season form + scoring rates for one team, used by the Poisson model. */
export async function teamStats({ leagueId, season, teamId }) {
  for (const s of seasonCandidates(SPORT, season)) {
    const body = await apiGet(SPORT, '/teams/statistics', { league: leagueId, season: s, team: teamId }, env.ttl.stats);
    const r = body?.response;
    const played = r?.fixtures?.played?.total ?? 0;
    if (!r || !played) continue;
    return {
      season: s,
      form: r.form || null,
      played: { home: r.fixtures.played.home || 0, away: r.fixtures.played.away || 0, total: played },
      wins: { home: r.fixtures.wins?.home || 0, away: r.fixtures.wins?.away || 0, total: r.fixtures.wins?.total || 0 },
      draws: { total: r.fixtures.draws?.total || 0 },
      losses: { total: r.fixtures.loses?.total || 0 },
      scored: {
        home: num(r.goals?.for?.average?.home),
        away: num(r.goals?.for?.average?.away),
        total: num(r.goals?.for?.average?.total),
      },
      conceded: {
        home: num(r.goals?.against?.average?.home),
        away: num(r.goals?.against?.average?.away),
        total: num(r.goals?.against?.average?.total),
      },
      cleanSheets: r.clean_sheet?.total ?? null,
      failedToScore: r.failed_to_score?.total ?? null,
    };
  }
  return null;
}

export async function headToHead(homeId, awayId) {
  // No `last` param: it is not available on free plans, and the unfiltered call
  // works there. Trim client-side instead.
  const body = await apiGet(SPORT, '/fixtures/headtohead', { h2h: `${homeId}-${awayId}`, timezone: env.timezone }, env.ttl.stats);
  return (body?.response || [])
    .filter((f) => f.goals?.home !== null && f.goals?.home !== undefined)
    .slice(-8)
    .map((f) => ({
    date: f.fixture?.date,
    league: f.league?.name,
    home: f.teams?.home?.name,
    away: f.teams?.away?.name,
    score: `${f.goals?.home ?? '-'}-${f.goals?.away ?? '-'}`,
    homeId: String(f.teams?.home?.id),
    goals: { home: f.goals?.home ?? null, away: f.goals?.away ?? null },
  }));
}

/** Last N results for recency-weighted form. */
export async function recentGames(teamId, last = 6) {
  const body = await apiGet(SPORT, '/fixtures', { team: teamId, last, timezone: env.timezone }, env.ttl.stats);
  return (body?.response || []).map((f) => ({
    date: f.fixture?.date,
    isHome: String(f.teams?.home?.id) === String(teamId),
    scored: String(f.teams?.home?.id) === String(teamId) ? f.goals?.home : f.goals?.away,
    conceded: String(f.teams?.home?.id) === String(teamId) ? f.goals?.away : f.goals?.home,
    opponent: String(f.teams?.home?.id) === String(teamId) ? f.teams?.away?.name : f.teams?.home?.name,
  }));
}

export async function odds(fixtureId) {
  const body = await apiGet(SPORT, '/odds', { fixture: fixtureId }, env.ttl.odds);
  return body?.response || [];
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
