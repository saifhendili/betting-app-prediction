import { scoreMatrix, matrixOver, normalCdf, clamp, fairOdds } from './math.js';
import { blend } from './odds.js';

/**
 * Turns a statistical model + a de-vigged market into a flat list of candidate
 * bets, each carrying a blended probability, an edge and an expected value.
 * The risk profiles below are pure ranking/filtering on top of this list.
 */

// ── probability of "total > line" at an arbitrary line ───────────────────────
const matrixCache = new WeakMap();

/**
 * For a live model, `expected` already includes the goals on the board, so the
 * Poisson matrix must be built from the REMAINING expectation and the current
 * score added back as a fixed offset. Using `expected` directly would price
 * goals already scored as if they were still to come.
 */
function poissonParams(model) {
  if (model.live) {
    return {
      lamHome: model.live.remainingExpected.home,
      lamAway: model.live.remainingExpected.away,
      offHome: model.live.currentScore.home || 0,
      offAway: model.live.currentScore.away || 0,
    };
  }
  return { lamHome: model.expected.home, lamAway: model.expected.away, offHome: 0, offAway: 0 };
}

function remainingMatrix(model) {
  let m = matrixCache.get(model);
  if (!m) {
    const { lamHome, lamAway } = poissonParams(model);
    m = scoreMatrix(lamHome, lamAway, {
      maxGoals: model.sport === 'hockey' ? 12 : 10,
      rho: model.sport === 'hockey' ? -0.03 : -0.05,
    });
    matrixCache.set(model, m);
  }
  return m;
}

function overProbability(model, line) {
  if (model.sport === 'basketball') {
    // the basketball live model already folds the score into expected/sd
    const sd = model.projection?.sdTotal || 17;
    return 1 - normalCdf(line, model.expected.total, sd);
  }
  const { offHome, offAway } = poissonParams(model);
  const need = line - (offHome + offAway);
  if (need < 0) return 1; // already over the line
  return matrixOver(remainingMatrix(model), need);
}

function homeCoversProbability(model, homeLine) {
  // homeLine is the handicap applied to the home side: margin + homeLine > 0
  if (model.sport === 'basketball') {
    const sd = model.projection?.sdMargin || 11.5;
    return clamp(1 - normalCdf(-homeLine, model.expected.margin, sd), 0.01, 0.99);
  }
  const m = remainingMatrix(model);
  const { offHome, offAway } = poissonParams(model);
  const lead = offHome - offAway;
  let p = 0;
  for (let i = 0; i < m.length; i += 1)
    for (let j = 0; j < m[i].length; j += 1) if (i - j + lead + homeLine > 0) p += m[i][j];
  return p;
}

const fmtLine = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const signed = (n) => (n > 0 ? `+${fmtLine(n)}` : fmtLine(n));

/**
 * `volatility` drives which risk profile a candidate belongs to:
 *   low  → wide safety margin markets (double chance, far-from-line totals)
 *   mid  → main lines
 *   high → underdogs, long totals, correct scores
 */
function candidate({ market, selection, modelP, marketP, marketOdds, volatility, note, tags = [], conflictKey }, weight) {
  const b = blend(modelP, marketP, weight);
  const probability = clamp(b.probability, 0.005, 0.995);
  // Two expectations, on purpose:
  //  `ev`      uses the blended probability → the honest, vig-aware expectation
  //            (nearly always slightly negative, which is the truth about betting)
  //  `evModel` uses our independent model probability → the *value* signal the
  //            aggressive profile hunts, since the blend has already absorbed
  //            the bookmaker's own opinion and would mask any disagreement.
  const ev = Number.isFinite(marketOdds) ? probability * marketOdds - 1 : null;
  const evModel = Number.isFinite(marketOdds) ? modelP * marketOdds - 1 : null;
  return {
    id: `${market}:${selection}`.toLowerCase().replace(/\s+/g, '-'),
    market,
    selection,
    probability,
    modelProbability: modelP,
    marketProbability: b.marketProbability,
    edge: b.edge,
    fairOdds: fairOdds(probability),
    marketOdds: Number.isFinite(marketOdds) ? marketOdds : null,
    ev,
    evModel,
    volatility,
    // Picks sharing a conflict group are mutually exclusive or redundant
    // (over vs under on the same line, both sides of a handicap, home vs away),
    // so the shortlist may only ever contain one of them.
    conflictKey: conflictKey || `${market}:${selection}`,
    marketWeightUsed: b.weightUsed ?? null,
    note: note || null,
    tags,
    // A gap this large almost always means the model is missing information
    // (a key absence, a stale line, a dead rubber) rather than free money.
    disagreement: Number.isFinite(b.edge) && Math.abs(b.edge) > 0.15 ? 'extreme' : null,
  };
}

export function buildCandidates({ model, market, weight = 0.55, teams, staleMarket = false }) {
  const out = [];
  // `staleMarket` is set for a game in progress whose odds are pre-match: the
  // model knows the score and the quote does not, so blending them would drag a
  // correct in-play probability back towards a price that is simply out of date.
  // The price is still shown for reference, but it is not an input and there is
  // no meaningful edge against it.
  const w = market && !staleMarket ? weight : 0;
  const H = teams?.home?.name || 'Home';
  const A = teams?.away?.name || 'Away';
  const mlProbs = market?.moneyline?.probs || null;
  const mlOdds = market?.moneyline?.odds || null;
  const sport = model.sport;

  // ── Match winner ──────────────────────────────────────────────────────────
  const mlMarketName = sport === 'football' ? 'Match Winner' : 'Moneyline';
  const favProb = Math.max(model.outcome.home, model.outcome.away);
  out.push(
    candidate(
      {
        market: mlMarketName,
        selection: `${H} to win`,
        modelP: model.outcome.home,
        marketP: mlProbs?.home,
        marketOdds: mlOdds?.home,
        volatility: model.outcome.home > 0.6 ? 'low' : model.outcome.home > 0.42 ? 'mid' : 'high',
        tags: ['home', 'winner'],
      },
      w
    )
  );
  out.push(
    candidate(
      {
        market: mlMarketName,
        selection: `${A} to win`,
        modelP: model.outcome.away,
        marketP: mlProbs?.away,
        marketOdds: mlOdds?.away,
        volatility: model.outcome.away > 0.6 ? 'low' : model.outcome.away > 0.42 ? 'mid' : 'high',
        tags: ['away', 'winner'],
      },
      w
    )
  );
  if (sport === 'football') {
    out.push(
      candidate(
        {
          market: mlMarketName,
          selection: 'Draw',
          modelP: model.outcome.draw,
          marketP: mlProbs?.draw,
          marketOdds: mlOdds?.draw,
          volatility: 'high',
          tags: ['draw', 'winner'],
          conflictKey: 'winner',
        },
        w
      )
    );
  }

  // ── Double chance (football + hockey regulation) ──────────────────────────
  if (model.doubleChance) {
    const dcOdds = market?.doubleChance?.odds || {};
    // Market DC comes straight from the de-vigged 3-way, which is exact — but
    // ONLY if the book actually quoted a draw. Hockey/basketball moneylines are
    // two-way and already include overtime, so deriving a regulation double
    // chance from them would invent an edge that does not exist.
    const dcMarket = mlProbs && Number.isFinite(mlProbs.draw)
      ? {
          homeOrDraw: (mlProbs.home || 0) + (mlProbs.draw || 0),
          drawOrAway: (mlProbs.draw || 0) + (mlProbs.away || 0),
          homeOrAway: (mlProbs.home || 0) + (mlProbs.away || 0),
        }
      : {};
    const label = sport === 'hockey' ? ' (regulation)' : '';
    [
      ['homeOrDraw', `${H} or Draw${label}`, 'low'],
      ['drawOrAway', `Draw or ${A}${label}`, 'low'],
      ['homeOrAway', `${H} or ${A} — no draw${label}`, 'mid'],
    ].forEach(([key, selection, volatility]) => {
      if (!Number.isFinite(model.doubleChance[key])) return;
      out.push(
        candidate(
          {
            market: 'Double Chance',
            selection,
            modelP: model.doubleChance[key],
            marketP: dcMarket[key],
            marketOdds: dcOdds[key],
            volatility,
            tags: ['double-chance'],
            conflictKey: 'double-chance',
          },
          w
        )
      );
    });
  }

  // ── Totals: every line the model knows plus every line the book priced ────
  const unit = sport === 'basketball' ? 'points' : 'goals';
  const lines = new Set(Object.keys(model.totals || {}).map(Number));
  Object.keys(market?.totals || {}).forEach((l) => lines.add(Number(l)));
  [...lines]
    .filter((l) => Number.isFinite(l))
    .sort((a, b) => a - b)
    .forEach((line) => {
      const over = overProbability(model, line);
      const mk = market?.totals?.[line] || market?.totals?.[fmtLine(line)];
      const distance = Math.abs(model.expected.total - line) / (sport === 'basketball' ? 10 : 1);
      const vol = distance > 1.2 ? 'low' : distance > 0.5 ? 'mid' : 'mid';
      out.push(
        candidate(
          {
            market: 'Over/Under',
            selection: `Over ${fmtLine(line)} ${unit}`,
            modelP: over,
            marketP: mk?.probs?.over,
            marketOdds: mk?.odds?.over,
            volatility: over > 0.72 ? 'low' : over < 0.35 ? 'high' : vol,
            tags: ['totals', 'over'],
            conflictKey: `total:${fmtLine(line)}`,
          },
          w
        )
      );
      out.push(
        candidate(
          {
            market: 'Over/Under',
            selection: `Under ${fmtLine(line)} ${unit}`,
            modelP: 1 - over,
            marketP: mk?.probs?.under,
            marketOdds: mk?.odds?.under,
            volatility: 1 - over > 0.72 ? 'low' : 1 - over < 0.35 ? 'high' : vol,
            tags: ['totals', 'under'],
            conflictKey: `total:${fmtLine(line)}`,
          },
          w
        )
      );
    });

  // ── Both teams to score (football, hockey) ────────────────────────────────
  if (model.btts) {
    out.push(
      candidate(
        {
          market: 'Both Teams To Score',
          selection: 'Both teams score — Yes',
          modelP: model.btts.yes,
          marketP: market?.btts?.probs?.yes,
          marketOdds: market?.btts?.odds?.yes,
          volatility: model.btts.yes > 0.7 ? 'low' : 'mid',
          tags: ['btts'],
          conflictKey: 'btts',
        },
        w
      )
    );
    out.push(
      candidate(
        {
          market: 'Both Teams To Score',
          selection: 'Both teams score — No',
          modelP: model.btts.no,
          marketP: market?.btts?.probs?.no,
          marketOdds: market?.btts?.odds?.no,
          volatility: model.btts.no > 0.7 ? 'low' : 'mid',
          tags: ['btts'],
          conflictKey: 'btts',
        },
        w
      )
    );
  }

  // ── Handicaps / spreads ───────────────────────────────────────────────────
  const hcpLines = new Set();
  Object.keys(market?.spreads || {}).forEach((l) => Number.isFinite(Number(l)) && hcpLines.add(Number(l)));
  if (!hcpLines.size) {
    if (sport === 'basketball') {
      const base = model.projection?.spreadLine || 4.5;
      [-(base + 2.5), -(base - 2.5), base - 2.5, base + 2.5].forEach((l) => hcpLines.add(Math.round(l * 2) / 2));
    } else {
      [-1.5, 1.5].forEach((l) => hcpLines.add(l));
    }
  }
  [...hcpLines].sort((a, b) => a - b).forEach((homeLine) => {
    const p = homeCoversProbability(model, homeLine);
    const mk = market?.spreads?.[homeLine] || market?.spreads?.[fmtLine(homeLine)];
    out.push(
      candidate(
        {
          market: 'Handicap',
          selection: `${H} ${signed(homeLine)}`,
          modelP: p,
          marketP: mk?.probs?.home,
          marketOdds: mk?.odds?.home,
          volatility: p > 0.7 ? 'low' : p < 0.35 ? 'high' : 'mid',
          tags: ['handicap', 'home'],
          conflictKey: `hcp:${Math.abs(homeLine)}`,
        },
        w
      )
    );
    out.push(
      candidate(
        {
          market: 'Handicap',
          selection: `${A} ${signed(-homeLine)}`,
          modelP: 1 - p,
          marketP: mk?.probs?.away,
          marketOdds: mk?.odds?.away,
          volatility: 1 - p > 0.7 ? 'low' : 1 - p < 0.35 ? 'high' : 'mid',
          tags: ['handicap', 'away'],
          conflictKey: `hcp:${Math.abs(homeLine)}`,
        },
        w
      )
    );
  });

  // ── Correct score (aggressive only) ───────────────────────────────────────
  (model.correctScores || []).forEach((cs) => {
    out.push(
      candidate(
        {
          market: 'Correct Score',
          selection: `${cs.score} (${H}-${A})`,
          modelP: cs.p,
          marketP: undefined,
          marketOdds: undefined,
          volatility: 'high',
          tags: ['correct-score'],
        },
        w
      )
    );
  });

  // A stale market is a pre-match price on a game already under way: it no
  // longer exists, so it must not be shown as bettable nor feed value scoring
  // (0.73 × a dead 1.91 looks like +40% EV). Keep it for reference only.
  const priced = staleMarket
    ? out.map((c) => ({ ...c, staleOdds: c.marketOdds, marketOdds: null, ev: null, evModel: null }))
    : out;

  // Drop anything already decided — in a live game "Over 0.5" at 1-0 is settled,
  // and a 99% selection is not a bet anyone can place at a meaningful price.
  return priced.filter((c) => Number.isFinite(c.probability) && c.probability > 0.015 && c.probability < 0.985);
}

// ── Risk profiles ───────────────────────────────────────────────────────────

export const RISK_PROFILES = {
  easy: {
    key: 'easy',
    label: 'Easy',
    tagline: 'Safety first — high hit-rate, small returns',
    description:
      'Only selections the model gives a wide safety margin: double chance, heavy favourites and totals far from the projection. Typical price 1.15–1.55.',
    minProbability: 0.68,
    maxProbability: 0.9,
    allowVolatility: ['low', 'mid'],
    blockMarkets: ['Correct Score'],
    preferMarkets: ['Double Chance', 'Over/Under', 'Handicap'],
    oddsRange: [1.1, 1.7],
    evFloor: null,
    // probability first, but a pick with a real bookmaker price beats an
    // equally likely one we only have a theoretical fair price for
    sort: (a, b) => safeScore(b) - safeScore(a),
  },
  mid: {
    key: 'mid',
    label: 'Mid',
    tagline: 'Balanced — the main lines, best risk/reward',
    description:
      'Main markets around the projection: match winner, the key total, main handicap. Balances probability against price. Typical price 1.5–2.3.',
    minProbability: 0.47,
    maxProbability: 0.85,
    allowVolatility: ['low', 'mid'],
    blockMarkets: ['Correct Score'],
    preferMarkets: ['Match Winner', 'Moneyline', 'Over/Under', 'Handicap', 'Both Teams To Score'],
    oddsRange: [1.4, 2.6],
    evFloor: null,
    // reward probability but pay attention to the price
    sort: (a, b) => score(b) - score(a),
  },
  aggressive: {
    key: 'aggressive',
    label: 'Aggressive',
    tagline: 'Value hunting — where the model disagrees with the book',
    description:
      'Selections where the model is materially higher than the bookmaker: underdogs, long totals, correct scores. Lower hit-rate, big payouts. Typical price 2.2+.',
    minProbability: 0.18,
    maxProbability: 0.75,
    allowVolatility: ['low', 'mid', 'high'],
    blockMarkets: [],
    preferMarkets: [],
    oddsRange: [1.8, 25],
    evFloor: 0.02,
    sort: (a, b) => valueScore(b) - valueScore(a),
  },
};

// a placeable price is worth a small, deliberate thumb on the scale
const priced = (c) => (Number.isFinite(c.marketOdds) ? 1 : 0);

// easy-profile score: almost purely probability
const safeScore = (c) => c.probability * 100 + priced(c) * 2.5;

// mid-profile score: probability with a mild bonus for price and edge
const score = (c) =>
  c.probability * 100 + (c.edge ?? 0) * 60 + Math.min(c.marketOdds ?? c.fairOdds ?? 1.8, 3) * 4 + priced(c) * 3;

// aggressive score: value first, but don't chase a 5% shot for its price alone
const valueScore = (c) =>
  (c.evModel ?? c.edge ?? 0) * 100 + (c.edge ?? 0) * 40 + c.probability * 12 + priced(c) * 4;

/**
 * Confidence blends: how far from a coin flip, how much data we had, how much
 * the market agrees, and how many bookmakers priced it.
 */
export function confidenceFor(candidateItem, { model, market }) {
  const p = candidateItem.probability;
  let conf = 30 + (p - 0.5) * 95; // 0.5 → 30, 0.9 → 68

  // `market` / `market-loose` are the levels a model fitted to bookmaker odds
  // reports. They were missing here, so a model that reproduced the book to
  // within 1pp fell through to the "no data at all" penalty. A tight market fit
  // is good evidence for the probability itself (the market is the best public
  // predictor), though it adds nothing independent of the book.
  const QUALITY_SCORE = { high: 14, medium: 7, market: 8, 'market-loose': -4, low: -4, partial: -12, none: -18 };
  const quality = model?.dataQuality?.level;
  conf += QUALITY_SCORE[quality] ?? -18;

  // Only a COMPARABLE market earns the agreement bonus: a stale pre-match price
  // on a live game has a probability but no edge, and agreeing with a price
  // that no longer exists is not evidence of anything.
  if (Number.isFinite(candidateItem.marketProbability) && Number.isFinite(candidateItem.edge)) {
    const agree = 1 - Math.min(Math.abs(candidateItem.edge), 0.25) / 0.25;
    conf += 6 + agree * 10; // market coverage is itself a confidence boost
    if (market?.bookmakerCount >= 5) conf += 4;
  } else {
    conf -= 6; // no market anchor
  }

  if (candidateItem.volatility === 'high') conf -= 7;
  if (candidateItem.volatility === 'low') conf += 4;

  return Math.round(clamp(conf, 5, 96));
}

function withinOdds(c, [lo, hi]) {
  const price = c.marketOdds ?? c.fairOdds;
  if (!Number.isFinite(price)) return true;
  // Strict on the low end: a 1.05 "certainty" is not worth staking.
  // Generous on the high end so long-shot value still surfaces.
  return price >= lo && price <= hi + (hi > 5 ? 50 : 0.6);
}

/** Rank the candidate list for one risk profile and return the top `limit`. */
export function rankForRisk(candidates, risk, { model, market, limit = 4 } = {}) {
  const profile = RISK_PROFILES[risk] || RISK_PROFILES.mid;

  let pool = candidates.filter(
    (c) =>
      c.probability >= profile.minProbability &&
      c.probability <= profile.maxProbability &&
      profile.allowVolatility.includes(c.volatility) &&
      !profile.blockMarkets.includes(c.market) &&
      withinOdds(c, profile.oddsRange)
  );

  if (profile.evFloor !== null) {
    const withEv = pool.filter((c) => (c.evModel ?? c.edge ?? -1) >= profile.evFloor);
    if (withEv.length >= 3) {
      pool = withEv;
    } else {
      // Too few clear the value floor to make a useful list — top it up with the
      // next-best positive-edge candidates rather than returning a single row.
      const rest = pool
        .filter((c) => !withEv.includes(c))
        .sort((a, b) => (b.evModel ?? b.edge ?? -1) - (a.evModel ?? a.edge ?? -1));
      pool = [...withEv, ...rest].slice(0, Math.max(5, withEv.length));
    }
  }

  // relax progressively rather than returning nothing
  if (!pool.length) {
    pool = candidates.filter(
      (c) => c.probability >= profile.minProbability * 0.85 && !profile.blockMarkets.includes(c.market)
    );
  }
  if (!pool.length) pool = [...candidates];

  const ranked = [...pool].sort(profile.sort);

  // One pick per market on the first pass, then at most one more each, so the
  // shortlist stays diverse instead of showing the same bet at three lines.
  const perMarket = new Map();
  const usedConflicts = new Set();
  const direction = new Map(); // market -> 'over' | 'under', first one wins
  const picks = [];
  const dirOf = (c) => (c.tags.includes('over') ? 'over' : c.tags.includes('under') ? 'under' : null);
  const take = (cap) => {
    for (const c of ranked) {
      if (picks.length >= limit) return;
      const used = perMarket.get(c.market) || 0;
      if (used >= cap || picks.includes(c)) continue;
      if (usedConflicts.has(c.conflictKey)) continue;
      // recommending "over 200.5" next to "under 212.5" reads as a contradiction
      const dir = dirOf(c);
      if (dir && direction.has(c.market) && direction.get(c.market) !== dir) continue;
      if (dir) direction.set(c.market, dir);
      perMarket.set(c.market, used + 1);
      usedConflicts.add(c.conflictKey);
      picks.push(c);
    }
  };
  take(1);
  take(2);

  return picks.map((c, i) => {
    const confidence = confidenceFor(c, { model, market });
    return {
      ...c,
      confidence,
      stars: Math.max(1, Math.min(5, Math.round(confidence / 20))),
      rank: i + 1,
      isTopPick: i === 0,
    };
  });
}

export { overProbability, homeCoversProbability };
