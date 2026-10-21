import { scoreMatrix, matrixOutcomes, matrixOver, matrixBtts, topScores, shrink, clamp } from './math.js';

const PRIOR_HOME_GOALS = 3.15;
const PRIOR_AWAY_GOALS = 2.85;
const LINES = [3.5, 4.5, 5.5, 6.5];
const OT_HOME_EDGE = 0.52;      // home team wins ~52% of games decided after regulation

const pick = (...vals) => vals.find((v) => Number.isFinite(v) && v > 0) ?? null;

function formFactor(recent, seasonAvg, weight = 0.3) {
  if (!recent?.length || !Number.isFinite(seasonAvg) || seasonAvg <= 0) return 1;
  const scored = recent.reduce((a, g) => a + (Number(g.scored) || 0), 0) / recent.length;
  return clamp(1 + weight * (scored / seasonAvg - 1), 0.85, 1.18);
}

export function hockeyModel({ home, away, homeRecent, awayRecent }) {
  const rawHome = ((pick(home?.scored?.home, home?.scored?.total) ?? PRIOR_HOME_GOALS) +
    (pick(away?.conceded?.away, away?.conceded?.total) ?? PRIOR_HOME_GOALS)) / 2;
  const rawAway = ((pick(away?.scored?.away, away?.scored?.total) ?? PRIOR_AWAY_GOALS) +
    (pick(home?.conceded?.home, home?.conceded?.total) ?? PRIOR_AWAY_GOALS)) / 2;

  const n = (home?.played?.total || 0) + (away?.played?.total || 0);
  let lambdaHome = shrink(rawHome, PRIOR_HOME_GOALS, n, 8) * formFactor(homeRecent, home?.scored?.total);
  let lambdaAway = shrink(rawAway, PRIOR_AWAY_GOALS, n, 8) * formFactor(awayRecent, away?.scored?.total);

  lambdaHome = clamp(lambdaHome, 1.2, 6);
  lambdaAway = clamp(lambdaAway, 1.1, 6);

  const m = scoreMatrix(lambdaHome, lambdaAway, { maxGoals: 12, rho: -0.03 });
  const reg = matrixOutcomes(m);

  // Most hockey leagues decide ties in OT/shootout → fold the draw into the moneyline.
  const mlHome = reg.home + reg.draw * OT_HOME_EDGE;
  const mlAway = reg.away + reg.draw * (1 - OT_HOME_EDGE);

  const totals = {};
  LINES.forEach((line) => {
    const over = matrixOver(m, line);
    totals[line] = { over, under: 1 - over };
  });

  const btts = matrixBtts(m);

  return {
    sport: 'hockey',
    expected: { home: round2(lambdaHome), away: round2(lambdaAway), total: round2(lambdaHome + lambdaAway) },
    outcome: { home: mlHome, draw: 0, away: mlAway },
    regulation: { home: reg.home, draw: reg.draw, away: reg.away },
    doubleChance: { homeOrDraw: reg.home + reg.draw, drawOrAway: reg.draw + reg.away, homeOrAway: reg.home + reg.away },
    totals,
    btts: { yes: btts, no: 1 - btts },
    correctScores: topScores(m, 4),
    form: { home: formString(homeRecent), away: formString(awayRecent) },
    dataQuality: dataQuality(home, away, n),
  };
}

function formString(recent) {
  if (!recent?.length) return null;
  return recent.slice(-6).map((g) => (g.scored > g.conceded ? 'W' : g.scored === g.conceded ? 'D' : 'L')).join('');
}

function dataQuality(home, away, n) {
  if (!home && !away) return { level: 'none', note: 'No season statistics available — league priors only.' };
  if (!home || !away) return { level: 'partial', note: 'Statistics for only one team.' };
  if (n < 8) return { level: 'low', note: `Only ${n} games of history this season.` };
  if (n < 20) return { level: 'medium', note: `${n} games of history.` };
  return { level: 'high', note: `${n} games of history.` };
}

const round2 = (v) => Math.round(v * 100) / 100;
