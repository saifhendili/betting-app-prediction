import { normalise, clamp } from './math.js';

/**
 * Bookmaker odds are the single strongest public predictor available, so the
 * final probabilities are a fusion of our model with the de-vigged market.
 * Disagreement between the two is exactly what the "aggressive" profile hunts.
 */

const toNum = (v) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 1 ? n : null;
};

/**
 * Strip the bookmaker margin: p_i = (1/o_i) / Σ(1/o_j).
 *
 * The overround is also a validity check. A genuine book always prices a market
 * at an overround above 1 (that is the margin); anything at or below 1, or
 * absurdly high, means the selections we paired up are not actually
 * complementary — e.g. a full-time price accidentally matched with a
 * first-half one. Those pairs are rejected rather than silently de-vigged into
 * nonsense.
 */
export function devig(oddsMap, { validate = true } = {}) {
  const inv = {};
  Object.entries(oddsMap).forEach(([k, o]) => {
    const n = toNum(o);
    if (n) inv[k] = 1 / n;
  });
  if (!Object.keys(inv).length) return null;
  const overround = Object.values(inv).reduce((a, b) => a + b, 0);
  if (validate && (overround < 1.0 || overround > 1.4)) return null;
  const probs = normalise(inv);
  return { probs, overround: Math.round(overround * 1000) / 1000 };
}

/**
 * Market identification is a WHITELIST of fully-anchored names, not a
 * blacklist of props.
 *
 * The feed returns dozens of bet types per fixture and several read like the
 * market we want: "Yellow Over/Under" (cards, not goals), "Goals Over/Under
 * First Half", "Home Team Goals". Matching loosely merged card totals into goal
 * totals and produced impossible prices — an over/under pair whose implied
 * probabilities summed to less than 1. Anchoring both ends of the name is what
 * makes this safe; EXCLUDE_RE stays as a second line of defence.
 */
const EXCLUDE_RE =
  /(half|1st|2nd|first|second|quarter|period|\bht\b|team|player|corner|card|yellow|red|booking|minute|interval|exact|odd\/even|margin|method|race to|highest|both halves|rest of|shot|foul|offside|penalt)/i;

const MARKET_NAMES = {
  moneyline: [/^match winner$/i, /^home\/away$/i, /^3way result$/i, /^full time result$/i, /^1x2$/i, /^winner$/i],
  totals: [/^goals over\/under$/i, /^over\/under$/i, /^total goals$/i, /^total points$/i, /^points over\/under$/i],
  doubleChance: [/^double chance$/i],
  btts: [/^both teams score$/i, /^both teams to score$/i],
  spread: [/^asian handicap$/i, /^handicap$/i, /^handicap result$/i, /^point spread$/i, /^spread$/i],
};

function classifyMarket(name) {
  const clean = String(name || '').trim();
  if (!clean || EXCLUDE_RE.test(clean)) return null;
  for (const [market, patterns] of Object.entries(MARKET_NAMES)) {
    if (patterns.some((re) => re.test(clean))) return market;
  }
  return null;
}

/**
 * Only half-integer lines are clean two-way bets. Integer lines can push and
 * quarter lines (x.25 / x.75) are split stakes — neither is a simple
 * "total > line" question, so the model must not treat them as one.
 */
const isCleanLine = (line) =>
  Number.isFinite(line) &&
  Math.abs(line * 2 - Math.round(line * 2)) < 1e-9 &&
  Math.abs(line - Math.trunc(line)) > 0.4;

const HOME_RE = /^(home|1|hom)$/i;
const AWAY_RE = /^(away|2|awa)$/i;
const DRAW_RE = /^(draw|x|tie)$/i;

/** Extract one bookmaker's markets, each de-vigged on its own. */
function extractBook(bk, { sport, skipped }) {
  const out = { name: bk.name, moneyline: null, totals: {}, doubleChance: null, btts: null, spreads: {} };
  const ml = {};
  const totals = {};
  const dc = {};
  const btts = {};
  const spreads = {};

  (bk.bets || []).forEach((bet) => {
    const market = classifyMarket(bet.name);
    if (!market) return;

    (bet.values || []).forEach((v) => {
      const odd = toNum(v.odd);
      if (!odd) return;
      const label = String(v.value ?? '').trim();

      if (market === 'moneyline') {
        if (HOME_RE.test(label)) ml.home = odd;
        else if (AWAY_RE.test(label)) ml.away = odd;
        else if (DRAW_RE.test(label)) ml.draw = odd;
        return;
      }

      if (market === 'doubleChance') {
        const k = label.toLowerCase().replace(/\s/g, '');
        if (/^(home\/draw|1x|homeordraw)$/.test(k)) dc.homeOrDraw = odd;
        else if (/^(home\/away|12|homeoraway)$/.test(k)) dc.homeOrAway = odd;
        else if (/^(draw\/away|x2|draworaway)$/.test(k)) dc.drawOrAway = odd;
        return;
      }

      if (market === 'btts') {
        const k = label.toLowerCase();
        if (k.startsWith('y')) btts.yes = odd;
        else if (k.startsWith('n')) btts.no = odd;
        return;
      }

      if (market === 'totals') {
        const m = label.match(/(over|under)\s*([\d.]+)/i) || label.match(/^(over|under)$/i);
        if (!m) return;
        const line = m[2] ? Number(m[2]) : Number(String(bet.name).match(/([\d.]+)/)?.[1]);
        if (!isCleanLine(line)) {
          skipped.asianTotals += 1;
          return;
        }
        totals[line] = totals[line] || {};
        totals[line][m[1].toLowerCase()] = odd;
        return;
      }

      if (market === 'spread') {
        const m = label.match(/(home|away)\s*([+-]?[\d.]+)/i);
        if (!m) return;
        const line = Number(m[2]);
        if (!isCleanLine(line)) {
          skipped.asianHandicaps += 1;
          return;
        }
        const side = m[1].toLowerCase();
        // key from the home team's perspective so Home -1.5 and Away +1.5 pair up
        const homeLine = side === 'home' ? line : -line;
        spreads[homeLine] = spreads[homeLine] || {};
        spreads[homeLine][side] = odd;
      }
    });
  });

  const mlKeys = Object.keys(ml);
  if (mlKeys.length >= 2) {
    const d = devig(ml);
    if (d) out.moneyline = { odds: ml, ...d };
    else skipped.invalidPairs += 1;
  }

  Object.entries(totals).forEach(([line, sides]) => {
    if (!sides.over || !sides.under) return;
    const d = devig(sides);
    if (d) out.totals[line] = { odds: sides, ...d };
    else skipped.invalidPairs += 1;
  });

  Object.entries(spreads).forEach(([line, sides]) => {
    if (!sides.home || !sides.away) return;
    const d = devig(sides);
    if (d) out.spreads[line] = { odds: sides, ...d };
    else skipped.invalidPairs += 1;
  });

  if (btts.yes && btts.no) {
    const d = devig(btts);
    if (d) out.btts = { odds: btts, ...d };
    else skipped.invalidPairs += 1;
  }

  if (Object.keys(dc).length >= 2) out.doubleChance = { odds: dc };

  return out;
}

const median = (arr) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const medianOdds = (arr) => {
  const v = median(arr);
  return v === null ? null : Math.round(v * 100) / 100;
};

/** Median of already-de-vigged probabilities across books, then renormalised. */
function consensus(books, pick, keys) {
  const probs = {};
  const odds = {};
  const overrounds = [];
  let contributors = 0;

  keys.forEach((k) => {
    probs[k] = [];
    odds[k] = [];
  });

  books.forEach((b) => {
    const m = pick(b);
    if (!m?.probs) return;
    if (!keys.every((k) => Number.isFinite(m.probs[k]))) return;
    contributors += 1;
    keys.forEach((k) => {
      probs[k].push(m.probs[k]);
      if (Number.isFinite(m.odds?.[k])) odds[k].push(m.odds[k]);
    });
    if (Number.isFinite(m.overround)) overrounds.push(m.overround);
  });

  if (!contributors) return null;

  const medProbs = {};
  keys.forEach((k) => {
    medProbs[k] = median(probs[k]);
  });
  const total = Object.values(medProbs).reduce((a, b) => a + b, 0);
  if (!total) return null;

  const finalOdds = {};
  keys.forEach((k) => {
    const o = medianOdds(odds[k]);
    if (o) finalOdds[k] = o;
  });

  return {
    probs: Object.fromEntries(Object.entries(medProbs).map(([k, v]) => [k, v / total])),
    odds: finalOdds,
    overround: overrounds.length ? Math.round(median(overrounds) * 1000) / 1000 : null,
    books: contributors,
  };
}

/**
 * Parse an API-SPORTS odds payload into de-vigged consensus probabilities.
 *
 * Each bookmaker is de-vigged on its own and the probabilities are then
 * combined by median — never the other way round. Taking the median of raw odds
 * across books can pair prices from different snapshots and produce a market
 * whose two sides imply less than 100%, which is impossible.
 */
export function parseOdds(raw, { sport } = {}) {
  const bookmakers = [];
  (Array.isArray(raw) ? raw : []).forEach((row) => {
    (row.bookmakers || []).forEach((bk) => bookmakers.push(bk));
  });
  if (!bookmakers.length) return null;

  const skipped = { asianTotals: 0, asianHandicaps: 0, invalidPairs: 0 };
  const books = bookmakers.map((bk) => extractBook(bk, { sport, skipped }));

  const mlKeys = sport === 'football' ? ['home', 'draw', 'away'] : ['home', 'away'];
  const moneyline =
    consensus(books, (b) => b.moneyline, mlKeys) || consensus(books, (b) => b.moneyline, ['home', 'away']);

  const totals = {};
  const totalLines = new Set();
  books.forEach((b) => Object.keys(b.totals).forEach((l) => totalLines.add(l)));
  totalLines.forEach((line) => {
    const c = consensus(books, (b) => b.totals[line], ['over', 'under']);
    if (c) totals[line] = c;
  });

  const spreads = {};
  const spreadLines = new Set();
  books.forEach((b) => Object.keys(b.spreads).forEach((l) => spreadLines.add(l)));
  spreadLines.forEach((line) => {
    const c = consensus(books, (b) => b.spreads[line], ['home', 'away']);
    if (c) spreads[line] = c;
  });

  const btts = consensus(books, (b) => b.btts, ['yes', 'no']);

  const dcOdds = {};
  ['homeOrDraw', 'homeOrAway', 'drawOrAway'].forEach((k) => {
    const o = medianOdds(books.map((b) => b.doubleChance?.odds?.[k]).filter(Number.isFinite));
    if (o) dcOdds[k] = o;
  });

  const names = [...new Set(bookmakers.map((b) => b.name))];
  const result = {
    bookmakers: names.slice(0, 12),
    bookmakerCount: names.length,
    moneyline,
    totals,
    spreads,
    btts,
    doubleChance: Object.keys(dcOdds).length >= 2 ? { odds: dcOdds } : null,
    skipped,
  };

  const hasAnything = moneyline || Object.keys(totals).length || btts || Object.keys(spreads).length;
  return hasAnything ? result : null;
}

/**
 * Weighted fusion of a model probability with the market probability.
 *
 * The weight is adaptive: a small disagreement with the book is plausibly real
 * signal, but a large one is nearly always the model missing information (an
 * absence, a stale line, a dead rubber) or bad input data. So the further the
 * two drift apart, the more the market is trusted — which stops the app
 * confidently recommending a fake 40pp "edge".
 */
export function blend(modelP, marketP, weight) {
  if (!Number.isFinite(marketP)) return { probability: modelP, edge: null, marketProbability: null, weightUsed: 0 };
  const base = clamp(weight, 0, 1);
  // A zero weight means "the market price is not comparable to this model"
  // (e.g. an in-play model against a pre-match quote). Never let the adaptive
  // escalation below drag such a price back into the blend.
  if (base === 0) return { probability: modelP, edge: null, marketProbability: marketP, weightUsed: 0 };
  const gap = Math.abs(modelP - marketP);
  const w = clamp(base + Math.max(0, gap - 0.1) * 1.5, base, 0.88);
  return {
    probability: clamp(modelP * (1 - w) + marketP * w, 0.005, 0.995),
    marketProbability: marketP,
    edge: modelP - marketP,
    weightUsed: Math.round(w * 100) / 100,
  };
}
