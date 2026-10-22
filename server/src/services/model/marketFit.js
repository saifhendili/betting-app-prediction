import {
  scoreMatrix, matrixOutcomes, matrixOver, matrixBtts, topScores, normalInv, clamp,
} from './math.js';

/**
 * Builds a model out of the bookmaker market alone.
 *
 * Why this exists: API-SPORTS free plans cannot read the current season, so
 * team statistics are unavailable and a stats model would fall back to generic
 * league priors — i.e. the same prediction for every game. The odds, however,
 * ARE available, and they are the single best public estimate of a result.
 *
 * So we invert them: find the scoring parameters whose implied distribution
 * best reproduces every price the book published. That buys two things a raw
 * odds screen does not give you:
 *   1. a coherent joint distribution, so every market the book DIDN'T price
 *      (alternate totals, correct scores, BTTS, handicaps) can be derived
 *      consistently from the ones it did;
 *   2. a single probability per selection that the risk profiles can rank.
 *
 * What it explicitly does NOT give you is an edge — if the market is your only
 * information you cannot disagree with it. The payload says so, and the
 * aggressive profile is told not to pretend otherwise.
 */

const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;

/** Pull every usable target out of the parsed market. */
function targetsFrom(market, { sport }) {
  const outcome = market?.moneyline?.probs
    ? {
        home: market.moneyline.probs.home,
        draw: Number.isFinite(market.moneyline.probs.draw) ? market.moneyline.probs.draw : null,
        away: market.moneyline.probs.away,
      }
    : null;

  // The parser has already dropped Asian lines; keep the few lines nearest the
  // book's own centre of gravity. More targets is not better — distant lines
  // (0.5, 8.5) carry almost no information and drag the fit around.
  const allTotals = Object.entries(market?.totals || {})
    .map(([line, t]) => ({ line: Number(line), over: t?.probs?.over }))
    .filter((t) => Number.isFinite(t.line) && Number.isFinite(t.over) && t.over > 0.02 && t.over < 0.98);
  const centre = allTotals.length
    ? allTotals.reduce((best, t) => (Math.abs(t.over - 0.5) < Math.abs(best.over - 0.5) ? t : best), allTotals[0]).line
    : null;
  const totals = centre === null
    ? []
    : allTotals.sort((a, b) => Math.abs(a.line - centre) - Math.abs(b.line - centre)).slice(0, 3);

  const btts = Number.isFinite(market?.btts?.probs?.yes) ? market.btts.probs.yes : null;

  const spreads = Object.entries(market?.spreads || {})
    .map(([line, sp]) => ({ line: Number(line), home: sp?.probs?.home }))
    .filter((sp) => Number.isFinite(sp.line) && Number.isFinite(sp.home));

  return { outcome, totals, btts, spreads, sport };
}

const hasSignal = (t) => Boolean(t.outcome) || t.totals.length > 0;

/**
 * Two-parameter fit by coarse-then-fine grid search. Only λ_home and λ_away are
 * free, so a grid is both robust (no local minima trouble) and fast enough.
 */
function fitPoisson(targets, { rho, maxGoals, bounds }) {
  /**
   * Objective: weighted mean squared error against the published prices.
   *
   * Weight is assigned per *market block*, not per target, and each block's
   * weight is shared among its members. Otherwise a book that quotes ten total
   * lines and one 1X2 would let the totals dictate the fit and the match-winner
   * probabilities — the thing users care most about — would come out wrong.
   */
  const W_OUTCOME = 0.55;
  const W_TOTALS = 0.35;
  const W_BTTS = 0.1;

  const score = (lh, la) => {
    const m = scoreMatrix(lh, la, { maxGoals, rho });
    let err = 0;
    let weight = 0;

    if (targets.outcome) {
      const o = matrixOutcomes(m);
      const parts = [[o.home, targets.outcome.home], [o.away, targets.outcome.away]];
      if (Number.isFinite(targets.outcome.draw)) parts.push([o.draw, targets.outcome.draw]);
      const w = W_OUTCOME / parts.length;
      parts.forEach(([got, want]) => {
        err += w * (got - want) ** 2;
      });
      weight += W_OUTCOME;
    }
    if (targets.totals.length) {
      const w = W_TOTALS / targets.totals.length;
      targets.totals.forEach((t) => {
        err += w * (matrixOver(m, t.line) - t.over) ** 2;
      });
      weight += W_TOTALS;
    }
    if (Number.isFinite(targets.btts)) {
      err += W_BTTS * (matrixBtts(m) - targets.btts) ** 2;
      weight += W_BTTS;
    }
    return weight ? err / weight : Infinity;
  };

  const search = (loH, hiH, loA, hiA, step) => {
    let best = { err: Infinity, lh: (loH + hiH) / 2, la: (loA + hiA) / 2 };
    for (let lh = loH; lh <= hiH + 1e-9; lh += step)
      for (let la = loA; la <= hiA + 1e-9; la += step) {
        const err = score(lh, la);
        if (err < best.err) best = { err, lh, la };
      }
    return best;
  };

  const [lo, hi] = bounds;
  const coarse = search(lo, hi, lo, hi, 0.1);
  const fine = search(
    Math.max(lo, coarse.lh - 0.1), Math.min(hi, coarse.lh + 0.1),
    Math.max(lo, coarse.la - 0.1), Math.min(hi, coarse.la + 0.1),
    0.01
  );
  return fine.err <= coarse.err ? fine : coarse;
}

/** Root-mean-square error expressed in probability points, for honesty in the UI. */
const fitQuality = (err, miss = 0) => {
  const rms = Math.sqrt(Math.max(err, 0));
  if (miss > MAX_OUTCOME_MISS) {
    return {
      level: 'market-loose',
      note: `Derived from bookmaker odds, but the fit misses the published match-winner prices by ${(miss * 100).toFixed(1)}pp — the book's markets are not mutually consistent, so treat this as indicative only.`,
    };
  }
  if (rms < 0.01) return { level: 'market', note: 'Derived from bookmaker odds (reproduces every published price to within 1pp).' };
  if (rms < 0.025) return { level: 'market', note: `Derived from bookmaker odds (fit within ${(rms * 100).toFixed(1)}pp).` };
  return {
    level: 'market-loose',
    note: `Derived from bookmaker odds with a ${(rms * 100).toFixed(1)}pp residual — the published prices do not fully agree with each other.`,
  };
};

/**
 * How far the fitted distribution lands from the single most important market.
 * If a fit cannot reproduce the 1X2 prices it was given, it is not usable: the
 * inputs must be mutually inconsistent, and showing a "72%" where the book says
 * "39%" would be worse than showing nothing.
 */
function outcomeMiss(fittedOutcome, target) {
  if (!target) return 0;
  const diffs = [Math.abs(fittedOutcome.home - target.home), Math.abs(fittedOutcome.away - target.away)];
  if (Number.isFinite(target.draw)) diffs.push(Math.abs(fittedOutcome.draw - target.draw));
  return Math.max(...diffs);
}

const MAX_OUTCOME_MISS = 0.05; // 5 percentage points

export function footballFromMarket(market) {
  const targets = targetsFrom(market, { sport: 'football' });
  if (!hasSignal(targets)) return null;

  let { lh, la, err } = fitPoisson(targets, { rho: -0.05, maxGoals: 10, bounds: [0.1, 5] });

  // Re-fit on the match winner alone if the combined fit drifted off it.
  if (targets.outcome) {
    const check = matrixOutcomes(scoreMatrix(lh, la, { maxGoals: 10, rho: -0.05 }));
    if (outcomeMiss(check, targets.outcome) > MAX_OUTCOME_MISS) {
      const retry = fitPoisson(
        { ...targets, totals: targets.totals.slice(0, 1), btts: null },
        { rho: -0.05, maxGoals: 10, bounds: [0.1, 5] }
      );
      const retryCheck = matrixOutcomes(scoreMatrix(retry.lh, retry.la, { maxGoals: 10, rho: -0.05 }));
      if (outcomeMiss(retryCheck, targets.outcome) < outcomeMiss(check, targets.outcome)) {
        ({ lh, la, err } = retry);
      }
    }
  }
  const m = scoreMatrix(lh, la, { maxGoals: 10, rho: -0.05 });
  const o = matrixOutcomes(m);

  const totals = {};
  [0.5, 1.5, 2.5, 3.5, 4.5].forEach((line) => {
    const over = matrixOver(m, line);
    totals[line] = { over, under: 1 - over };
  });
  const btts = matrixBtts(m);

  return {
    sport: 'football',
    source: 'market-implied',
    expected: { home: round2(lh), away: round2(la), total: round2(lh + la) },
    outcome: o,
    doubleChance: { homeOrDraw: o.home + o.draw, homeOrAway: o.home + o.away, drawOrAway: o.draw + o.away },
    totals,
    btts: { yes: btts, no: 1 - btts },
    correctScores: topScores(m, 4),
    form: { home: null, away: null },
    dataQuality: fitQuality(err, outcomeMiss(o, targets.outcome)),
    fit: {
      residual: round1(Math.sqrt(err) * 100),
      outcomeMissPp: round1(outcomeMiss(o, targets.outcome) * 100),
      targets: describeTargets(targets),
    },
  };
}

export function hockeyFromMarket(market) {
  const targets = targetsFrom(market, { sport: 'hockey' });
  if (!hasSignal(targets)) return null;

  const { lh, la, err } = fitPoisson(targets, { rho: -0.03, maxGoals: 12, bounds: [0.5, 7] });
  const m = scoreMatrix(lh, la, { maxGoals: 12, rho: -0.03 });
  const reg = matrixOutcomes(m);
  const otEdge = 0.52;

  const totals = {};
  [3.5, 4.5, 5.5, 6.5].forEach((line) => {
    const over = matrixOver(m, line);
    totals[line] = { over, under: 1 - over };
  });
  const btts = matrixBtts(m);

  return {
    sport: 'hockey',
    source: 'market-implied',
    expected: { home: round2(lh), away: round2(la), total: round2(lh + la) },
    outcome: { home: reg.home + reg.draw * otEdge, draw: 0, away: reg.away + reg.draw * (1 - otEdge) },
    regulation: reg,
    doubleChance: { homeOrDraw: reg.home + reg.draw, drawOrAway: reg.draw + reg.away, homeOrAway: reg.home + reg.away },
    totals,
    btts: { yes: btts, no: 1 - btts },
    correctScores: topScores(m, 4),
    form: { home: null, away: null },
    dataQuality: fitQuality(err, outcomeMiss({ home: reg.home + reg.draw * otEdge, draw: 0, away: reg.away + reg.draw * (1 - otEdge) }, targets.outcome)),
    fit: { residual: round1(Math.sqrt(err) * 100), targets: describeTargets(targets) },
  };
}

/**
 * Basketball needs no search: the total comes straight from the priced
 * over/under line and the margin from the moneyline, via the inverse normal.
 */
export function basketballFromMarket(market) {
  const targets = targetsFrom(market, { sport: 'basketball' });
  if (!hasSignal(targets)) return null;

  const TOTAL_SD_RATIO = 0.075;
  const MARGIN_SD_RATIO = 0.052;

  // Solve total T from P(over line) = market, where sd depends on T. Converges
  // in a handful of passes because the dependence is weak.
  let total = targets.totals.length
    ? targets.totals.reduce((a, t) => a + t.line, 0) / targets.totals.length
    : 215;
  if (targets.totals.length) {
    for (let i = 0; i < 8; i += 1) {
      const sd = clamp(total * TOTAL_SD_RATIO, 8, 30);
      // each priced line implies T = line + sd * Φ⁻¹(P(over))
      const estimates = targets.totals.map((t) => t.line + sd * normalInv(clamp(t.over, 0.02, 0.98)));
      total = estimates.reduce((a, b) => a + b, 0) / estimates.length;
      total = clamp(total, 100, 350);
    }
  }

  const sdTotal = clamp(total * TOTAL_SD_RATIO, 8, 30);
  const sdMargin = clamp(total * MARGIN_SD_RATIO, 6, 20);

  let margin;
  if (targets.outcome && Number.isFinite(targets.outcome.home)) {
    margin = sdMargin * normalInv(clamp(targets.outcome.home, 0.01, 0.99));
  } else if (targets.spreads.length) {
    // fall back to the handicap market: margin = line + sd * Φ⁻¹(P(home covers))
    const est = targets.spreads.map((sp) => -sp.line + sdMargin * normalInv(clamp(sp.home, 0.02, 0.98)));
    margin = est.reduce((a, b) => a + b, 0) / est.length;
  } else {
    margin = 0;
  }
  margin = clamp(margin, -40, 40);

  const ptsHome = (total + margin) / 2;
  const ptsAway = (total - margin) / 2;
  const pHome = clamp(1 - 0.5 * (1 + erf(-margin / (sdMargin * Math.SQRT2))), 0.01, 0.99);

  const totalsOut = {};
  // always a half-point line: whole numbers can push, which the model doesn't price
  const baseLine = Math.floor(total) + 0.5;
  [baseLine - 6, baseLine - 3, baseLine, baseLine + 3, baseLine + 6].forEach((line) => {
    const over = 1 - cdf(line, total, sdTotal);
    totalsOut[line] = { over, under: 1 - over };
  });

  const spreads = {};
  [-8, -5.5, -3.5, -1.5, 1.5, 3.5, 5.5, 8].forEach((line) => {
    spreads[line] = clamp(1 - cdf(-line, margin, sdMargin), 0.01, 0.99);
  });

  // residual: how well the reconstruction reproduces the prices we were given
  let err = 0;
  let n = 0;
  targets.totals.forEach((t) => {
    err += ((1 - cdf(t.line, total, sdTotal)) - t.over) ** 2;
    n += 1;
  });
  if (targets.outcome) {
    err += (pHome - targets.outcome.home) ** 2;
    n += 1;
  }

  return {
    sport: 'basketball',
    source: 'market-implied',
    expected: { home: round1(ptsHome), away: round1(ptsAway), total: round1(total), margin: round1(margin) },
    outcome: { home: pHome, draw: 0, away: 1 - pHome },
    projection: {
      totalLine: baseLine,
      spreadLine: Math.round(Math.abs(margin) * 2) / 2,
      sdMargin: round1(sdMargin),
      sdTotal: round1(sdTotal),
    },
    totals: totalsOut,
    spreads,
    form: { home: null, away: null },
    dataQuality: fitQuality(n ? err / n : 0, targets.outcome ? Math.abs(pHome - targets.outcome.home) : 0),
    fit: { residual: round1(Math.sqrt(n ? err / n : 0) * 100), targets: describeTargets(targets) },
  };
}

function describeTargets(t) {
  const bits = [];
  if (t.outcome) bits.push('match winner');
  if (t.totals.length) bits.push(`${t.totals.length} total line(s)`);
  if (Number.isFinite(t.btts)) bits.push('both teams to score');
  if (t.spreads.length) bits.push(`${t.spreads.length} handicap line(s)`);
  return bits.join(', ') || 'nothing usable';
}

// local normal helpers (kept here so this module is self-contained)
function erf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return z >= 0 ? y : -y;
}
const cdf = (x, mean, sd) => 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));

export function modelFromMarket(sport, market) {
  if (!market) return null;
  if (sport === 'football') return footballFromMarket(market);
  if (sport === 'hockey') return hockeyFromMarket(market);
  if (sport === 'basketball') return basketballFromMarket(market);
  return null;
}
