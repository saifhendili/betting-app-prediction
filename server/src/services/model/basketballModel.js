import { normalCdf, shrink, clamp } from './math.js';

const PRIOR_POINTS = 108;       // per team, per game — league-agnostic starting point
const MARGIN_SD_RATIO = 0.052;  // sd(margin) ≈ 5.2% of the projected total (~11.7 @ 225)
const TOTAL_SD_RATIO = 0.075;   // sd(total)  ≈ 7.5% of the projected total (~17 @ 225)

const pick = (...vals) => vals.find((v) => Number.isFinite(v) && v > 0) ?? null;

function formFactor(recent, seasonAvg, weight = 0.3) {
  if (!recent?.length || !Number.isFinite(seasonAvg) || seasonAvg <= 0) return 1;
  const scored = recent.reduce((a, g) => a + (Number(g.scored) || 0), 0) / recent.length;
  return clamp(1 + weight * (scored / seasonAvg - 1), 0.9, 1.1);
}

export function basketballModel({ home, away, homeRecent, awayRecent }) {
  const prior = pick(home?.scored?.total, away?.scored?.total) ?? PRIOR_POINTS;

  const rawHome = ((pick(home?.scored?.home, home?.scored?.total) ?? prior) +
    (pick(away?.conceded?.away, away?.conceded?.total) ?? prior)) / 2;
  const rawAway = ((pick(away?.scored?.away, away?.scored?.total) ?? prior) +
    (pick(home?.conceded?.home, home?.conceded?.total) ?? prior)) / 2;

  const n = (home?.played?.total || 0) + (away?.played?.total || 0);
  let ptsHome = shrink(rawHome, prior * 1.025, n, 5) * formFactor(homeRecent, home?.scored?.total);
  let ptsAway = shrink(rawAway, prior * 0.975, n, 5) * formFactor(awayRecent, away?.scored?.total);

  ptsHome = clamp(ptsHome, 50, 160);
  ptsAway = clamp(ptsAway, 50, 160);

  const total = ptsHome + ptsAway;
  const margin = ptsHome - ptsAway;

  // The spread of outcomes is not just game-to-game noise: our estimate of the
  // two teams' strength is itself uncertain, and that uncertainty shrinks as the
  // season progresses. Inflating sd by sqrt(1 + k/n) stops an 11-point
  // projection off 8 games claiming the same certainty as one off 60.
  const uncertainty = Math.sqrt(1 + 8 / Math.max(n, 2));
  const sdMargin = clamp(total * MARGIN_SD_RATIO * uncertainty, 6, 20);
  const sdTotal = clamp(total * TOTAL_SD_RATIO * uncertainty, 8, 30);

  // No draws in basketball: P(home) = P(margin > 0).
  const pHome = clamp(1 - normalCdf(0, margin, sdMargin), 0.01, 0.99);

  const totalLine = Math.round(total * 2) / 2 + (Number.isInteger(Math.round(total * 2) / 2) ? 0.5 : 0);
  const spreadLine = Math.round(Math.abs(margin) * 2) / 2;

  const totals = {};
  [totalLine - 6, totalLine - 3, totalLine, totalLine + 3, totalLine + 6].forEach((line) => {
    const over = 1 - normalCdf(line, total, sdTotal);
    totals[line] = { over, under: 1 - over };
  });

  const spreads = {};
  [-8, -5.5, -3.5, -1.5, 1.5, 3.5, 5.5, 8].forEach((line) => {
    // "home line" convention: home -3.5 wins if margin > 3.5
    spreads[line] = clamp(1 - normalCdf(-line, margin, sdMargin), 0.01, 0.99);
  });

  return {
    sport: 'basketball',
    expected: { home: round1(ptsHome), away: round1(ptsAway), total: round1(total), margin: round1(margin) },
    outcome: { home: pHome, draw: 0, away: 1 - pHome },
    projection: { totalLine, spreadLine, sdMargin: round1(sdMargin), sdTotal: round1(sdTotal) },
    totals,
    spreads,
    form: { home: formString(homeRecent), away: formString(awayRecent) },
    dataQuality: dataQuality(home, away, n),
  };
}

function formString(recent) {
  if (!recent?.length) return null;
  return recent.slice(-6).map((g) => (g.scored > g.conceded ? 'W' : 'L')).join('');
}

function dataQuality(home, away, n) {
  if (!home && !away) return { level: 'none', note: 'No season statistics available — league priors only.' };
  if (!home || !away) return { level: 'partial', note: 'Statistics for only one team.' };
  if (n < 8) return { level: 'low', note: `Only ${n} games of history this season.` };
  if (n < 20) return { level: 'medium', note: `${n} games of history.` };
  return { level: 'high', note: `${n} games of history.` };
}

const round1 = (v) => Math.round(v * 10) / 10;
