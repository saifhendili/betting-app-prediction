import { scoreMatrix, matrixOver, normalCdf, topScores, clamp } from './math.js';

/**
 * Converts a pre-match model into an in-play one.
 *
 * A pre-match Poisson/normal projection is simply wrong once a game is under
 * way: it doesn't know the score and it still expects a full game's worth of
 * scoring. Here the remaining expectation is scaled by the time left, the
 * remaining-goals distribution is computed, and the current score is added
 * back in — so "Over 2.5" at 1-0 with ten minutes left is priced correctly.
 */

const REGULATION = { football: 90, basketball: 48, hockey: 60 };

/** Best-effort minutes elapsed, from whatever the feed gives us. */
export function elapsedMinutes(game) {
  const { sport, status } = game;
  const full = REGULATION[sport];
  const raw = Number(status?.elapsed);
  const short = String(status?.short || '').toUpperCase();

  if (Number.isFinite(raw) && raw > 0 && raw <= full + 15) {
    if (sport === 'basketball' && raw <= 12) {
      // basketball feeds often report the clock within the current quarter
      const q = { Q1: 0, Q2: 12, Q3: 24, Q4: 36 }[short];
      if (q !== undefined) return clamp(q + (12 - raw), 0, full);
    }
    return clamp(raw, 0, full);
  }

  // fall back to the phase of the game
  const byPhase = {
    football: { '1H': 23, HT: 45, '2H': 68, ET: 100, P: 120, BT: 90 },
    basketball: { Q1: 6, Q2: 18, Q3: 30, Q4: 42, HL: 24, OT: 50, BT1: 12, BT2: 24, BT3: 36 },
    hockey: { P1: 10, P2: 30, P3: 50, PT: 20, BT: 40, OT: 62 },
  }[sport] || {};
  if (byPhase[short] !== undefined) return byPhase[short];
  return full / 2; // unknown phase — assume halfway
}

export function liveFootballOrHockey(pre, game, { sport }) {
  const full = REGULATION[sport];
  const elapsed = elapsedMinutes(game);
  const remaining = clamp(full - elapsed, 0, full);
  const fraction = remaining / full;

  const curHome = game.score.home ?? 0;
  const curAway = game.score.away ?? 0;

  // a floor keeps the matrix meaningful in the dying minutes
  const lamHome = Math.max(pre.expected.home * fraction, 0.02);
  const lamAway = Math.max(pre.expected.away * fraction, 0.02);

  const rho = sport === 'hockey' ? -0.03 : -0.05;
  const m = scoreMatrix(lamHome, lamAway, { maxGoals: 8, rho });

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let i = 0; i < m.length; i += 1)
    for (let j = 0; j < m[i].length; j += 1) {
      const h = curHome + i;
      const a = curAway + j;
      if (h > a) pHome += m[i][j];
      else if (h === a) pDraw += m[i][j];
      else pAway += m[i][j];
    }

  const expTotal = curHome + curAway + lamHome + lamAway;
  const lines = sport === 'hockey' ? [3.5, 4.5, 5.5, 6.5] : [0.5, 1.5, 2.5, 3.5, 4.5];
  const totals = {};
  lines.forEach((line) => {
    // remaining goals needed to clear the line, given what is already scored
    const need = line - (curHome + curAway);
    const over = need < 0 ? 1 : matrixOver(m, need);
    totals[line] = { over, under: 1 - over };
  });

  // both teams to score: whoever is on zero still has to find one
  let btts;
  if (curHome > 0 && curAway > 0) btts = 1;
  else if (curHome > 0) btts = 1 - Math.exp(-lamAway);
  else if (curAway > 0) btts = 1 - Math.exp(-lamHome);
  else btts = (1 - Math.exp(-lamHome)) * (1 - Math.exp(-lamAway));

  const otEdge = 0.52;
  const outcome =
    sport === 'hockey'
      ? { home: pHome + pDraw * otEdge, draw: 0, away: pAway + pDraw * (1 - otEdge) }
      : { home: pHome, draw: pDraw, away: pAway };

  return {
    ...pre,
    live: {
      elapsedMinutes: Math.round(elapsed),
      remainingMinutes: Math.round(remaining),
      currentScore: { home: curHome, away: curAway },
      remainingExpected: { home: round2(lamHome), away: round2(lamAway) },
    },
    expected: {
      home: round2(curHome + lamHome),
      away: round2(curAway + lamAway),
      total: round2(expTotal),
    },
    outcome,
    ...(sport === 'hockey' ? { regulation: { home: pHome, draw: pDraw, away: pAway } } : {}),
    doubleChance: { homeOrDraw: pHome + pDraw, drawOrAway: pDraw + pAway, homeOrAway: pHome + pAway },
    totals,
    btts: { yes: btts, no: 1 - btts },
    correctScores: topScores(m, 4).map((s) => {
      const [i, j] = s.score.split('-').map(Number);
      return { score: `${curHome + i}-${curAway + j}`, p: s.p };
    }),
    dataQuality: {
      ...pre.dataQuality,
      note: `${pre.dataQuality.note} In-play: ${Math.round(remaining)} of ${full} minutes left.`,
    },
  };
}

export function liveBasketball(pre, game) {
  const full = REGULATION.basketball;
  const elapsed = elapsedMinutes(game);
  const remaining = clamp(full - elapsed, 0, full);
  const fraction = remaining / full;

  const curHome = game.score.home ?? 0;
  const curAway = game.score.away ?? 0;

  const remHome = Math.max(pre.expected.home * fraction, 0.5);
  const remAway = Math.max(pre.expected.away * fraction, 0.5);

  const projHome = curHome + remHome;
  const projAway = curAway + remAway;
  const margin = projHome - projAway;
  const projTotal = projHome + projAway;

  // uncertainty shrinks with the clock: only the remaining minutes are random
  const scale = Math.sqrt(Math.max(fraction, 0.02));
  const sdMargin = clamp((pre.projection?.sdMargin || 11.5) * scale, 1.5, 22);
  const sdTotal = clamp((pre.projection?.sdTotal || 17) * scale, 2, 30);

  const pHome = clamp(1 - normalCdf(0, margin, sdMargin), 0.005, 0.995);

  const baseLine = Math.round(projTotal * 2) / 2 + 0.5;
  const totals = {};
  [baseLine - 6, baseLine - 3, baseLine, baseLine + 3, baseLine + 6].forEach((line) => {
    const over = 1 - normalCdf(line, projTotal, sdTotal);
    totals[line] = { over, under: 1 - over };
  });

  const spreads = {};
  [-8, -5.5, -3.5, -1.5, 1.5, 3.5, 5.5, 8].forEach((line) => {
    spreads[line] = clamp(1 - normalCdf(-line, margin, sdMargin), 0.005, 0.995);
  });

  return {
    ...pre,
    live: {
      elapsedMinutes: Math.round(elapsed),
      remainingMinutes: Math.round(remaining),
      currentScore: { home: curHome, away: curAway },
      remainingExpected: { home: round1(remHome), away: round1(remAway) },
    },
    expected: { home: round1(projHome), away: round1(projAway), total: round1(projTotal), margin: round1(margin) },
    outcome: { home: pHome, draw: 0, away: 1 - pHome },
    projection: {
      totalLine: baseLine,
      spreadLine: Math.round(Math.abs(margin) * 2) / 2,
      sdMargin: round1(sdMargin),
      sdTotal: round1(sdTotal),
    },
    totals,
    spreads,
    dataQuality: {
      ...pre.dataQuality,
      note: `${pre.dataQuality.note} In-play: ${Math.round(remaining)} of ${full} minutes left.`,
    },
  };
}

/** Dispatch: returns the pre-match model untouched for non-live games. */
export function applyLiveState(pre, game) {
  if (game.state !== 'live') return pre;
  if (game.sport === 'basketball') return liveBasketball(pre, game);
  return liveFootballOrHockey(pre, game, { sport: game.sport });
}

const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;
