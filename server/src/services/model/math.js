/** Small numeric toolbox: Poisson, Dixon-Coles, Normal. No dependencies. */

const logFactCache = [0, 0];
function logFactorial(n) {
  if (logFactCache[n] !== undefined) return logFactCache[n];
  let v = logFactCache[logFactCache.length - 1];
  for (let i = logFactCache.length; i <= n; i += 1) {
    v += Math.log(i);
    logFactCache[i] = v;
  }
  return logFactCache[n];
}

export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

/**
 * Dixon-Coles correction: independent Poisson under-prices 0-0/1-1 and
 * over-prices 1-0/0-1. rho ≈ -0.05 on football data.
 */
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Joint score-probability matrix, rows = home goals, cols = away goals. */
export function scoreMatrix(lambdaHome, lambdaAway, { maxGoals = 10, rho = 0 } = {}) {
  const home = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lambdaHome));
  const away = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lambdaAway));
  const m = [];
  let total = 0;
  for (let i = 0; i <= maxGoals; i += 1) {
    m[i] = [];
    for (let j = 0; j <= maxGoals; j += 1) {
      const p = home[i] * away[j] * (rho ? tau(i, j, lambdaHome, lambdaAway, rho) : 1);
      m[i][j] = Math.max(p, 0);
      total += m[i][j];
    }
  }
  // renormalise (truncation + tau both leak a little mass)
  for (let i = 0; i <= maxGoals; i += 1)
    for (let j = 0; j <= maxGoals; j += 1) m[i][j] /= total;
  return m;
}

export function matrixOutcomes(m) {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i < m.length; i += 1)
    for (let j = 0; j < m[i].length; j += 1) {
      if (i > j) home += m[i][j];
      else if (i === j) draw += m[i][j];
      else away += m[i][j];
    }
  return { home, draw, away };
}

/** P(total goals > line) for a half-integer line. */
export function matrixOver(m, line) {
  let over = 0;
  for (let i = 0; i < m.length; i += 1)
    for (let j = 0; j < m[i].length; j += 1) if (i + j > line) over += m[i][j];
  return over;
}

export function matrixBtts(m) {
  let yes = 0;
  for (let i = 1; i < m.length; i += 1)
    for (let j = 1; j < m[i].length; j += 1) yes += m[i][j];
  return yes;
}

/** P(home - away > line) — handicap / spread on a Poisson matrix. */
export function matrixHandicap(m, line) {
  let p = 0;
  for (let i = 0; i < m.length; i += 1)
    for (let j = 0; j < m[i].length; j += 1) if (i - j > line) p += m[i][j];
  return p;
}

export function topScores(m, n = 4) {
  const out = [];
  for (let i = 0; i < m.length; i += 1)
    for (let j = 0; j < m[i].length; j += 1) out.push({ score: `${i}-${j}`, p: m[i][j] });
  return out.sort((a, b) => b.p - a.p).slice(0, n);
}

/** Abramowitz-Stegun erf → normal CDF. Max error ~1.5e-7. */
export function normalCdf(x, mean = 0, sd = 1) {
  const z = (x - mean) / (sd * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/**
 * Inverse normal CDF (probit), Acklam's rational approximation.
 * Relative error < 1.15e-9 — needed to turn a market probability back into a
 * point spread or an expected total.
 */
export function normalInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;

  let q;
  let x;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
         ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Bayesian shrinkage of a noisy rate toward a prior. */
export function shrink(observed, prior, n, k = 6) {
  if (!Number.isFinite(observed)) return prior;
  if (!Number.isFinite(n) || n <= 0) return prior;
  return (n * observed + k * prior) / (n + k);
}

export function normalise(obj) {
  const total = Object.values(obj).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!total) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, (Number.isFinite(v) ? v : 0) / total]));
}

export const pct = (p) => Math.round(p * 1000) / 10;
export const fairOdds = (p) => (p > 0 ? Math.round((1 / p) * 100) / 100 : null);
