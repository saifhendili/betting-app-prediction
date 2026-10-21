import {
  scoreMatrix, matrixOutcomes, matrixOver, matrixBtts, matrixHandicap, topScores, shrink, clamp,
} from './math.js';

const PRIOR_HOME_GOALS = 1.5;
const PRIOR_AWAY_GOALS = 1.15;
const RHO = -0.05;              // Dixon-Coles low-score correction
const LINES = [0.5, 1.5, 2.5, 3.5, 4.5];

const pick = (...vals) => vals.find((v) => Number.isFinite(v) && v > 0) ?? null;

/** Recency multiplier from the last N games vs. the season rate, deliberately damped. */
function formFactor(recent, seasonAvg, { weight = 0.35, lo = 0.8, hi = 1.25 } = {}) {
  if (!recent?.length || !Number.isFinite(seasonAvg) || seasonAvg <= 0) return 1;
  const scored = recent.reduce((a, g) => a + (Number(g.scored) || 0), 0) / recent.length;
  const ratio = scored / seasonAvg;
  return clamp(1 + weight * (ratio - 1), lo, hi);
}

function formString(recent) {
  if (!recent?.length) return null;
  return recent
    .slice(-6)
    .map((g) => (g.scored > g.conceded ? 'W' : g.scored === g.conceded ? 'D' : 'L'))
    .join('');
}

export function footballModel({ home, away, homeRecent, awayRecent }) {
  // Expected goals: blend "what home scores at home" with "what away concedes away".
  const rawHome = ((pick(home?.scored?.home, home?.scored?.total) ?? PRIOR_HOME_GOALS) +
    (pick(away?.conceded?.away, away?.conceded?.total) ?? PRIOR_HOME_GOALS)) / 2;
  const rawAway = ((pick(away?.scored?.away, away?.scored?.total) ?? PRIOR_AWAY_GOALS) +
    (pick(home?.conceded?.home, home?.conceded?.total) ?? PRIOR_AWAY_GOALS)) / 2;

  const nHome = (home?.played?.home || 0) + (away?.played?.away || 0);
  const nAway = (away?.played?.away || 0) + (home?.played?.home || 0);

  let lambdaHome = shrink(rawHome, PRIOR_HOME_GOALS, nHome, 6);
  let lambdaAway = shrink(rawAway, PRIOR_AWAY_GOALS, nAway, 6);

  lambdaHome *= formFactor(homeRecent, home?.scored?.total);
  lambdaAway *= formFactor(awayRecent, away?.scored?.total);

  lambdaHome = clamp(lambdaHome, 0.25, 4.5);
  lambdaAway = clamp(lambdaAway, 0.2, 4.2);

  const m = scoreMatrix(lambdaHome, lambdaAway, { maxGoals: 10, rho: RHO });
  const { home: pH, draw: pD, away: pA } = matrixOutcomes(m);

  const totals = {};
  LINES.forEach((line) => {
    const over = matrixOver(m, line);
    totals[line] = { over, under: 1 - over };
  });

  const btts = matrixBtts(m);

  return {
    sport: 'football',
    expected: { home: round2(lambdaHome), away: round2(lambdaAway), total: round2(lambdaHome + lambdaAway) },
    outcome: { home: pH, draw: pD, away: pA },
    doubleChance: { homeOrDraw: pH + pD, homeOrAway: pH + pA, drawOrAway: pD + pA },
    totals,
    btts: { yes: btts, no: 1 - btts },
    handicap: {
      'home-1.5': matrixHandicap(m, 1.5),
      'away+1.5': 1 - matrixHandicap(m, 1.5),
      'home-0.5': matrixHandicap(m, 0.5),
    },
    correctScores: topScores(m, 4),
    form: { home: home?.form || formString(homeRecent), away: away?.form || formString(awayRecent) },
    dataQuality: dataQuality(home, away, nHome),
  };
}

function dataQuality(home, away, n) {
  if (!home && !away) return { level: 'none', note: 'No season statistics available — priors only.' };
  if (!home || !away) return { level: 'partial', note: 'Statistics for only one team — prediction is weak.' };
  if (n < 6) return { level: 'low', note: `Only ${n} relevant matches played this season.` };
  if (n < 14) return { level: 'medium', note: `${n} relevant matches of history.` };
  return { level: 'high', note: `${n} relevant matches of history.` };
}

const round2 = (v) => Math.round(v * 100) / 100;
export { formString };
