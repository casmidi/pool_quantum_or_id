/**
 * scoring/normalizers.js
 * Advanced normalization functions for converting raw wallet metrics
 * into consistent 0–100 scores.
 *
 * Supports multiple normalization strategies:
 *   - normLinear:   Linear interpolation within [min, max]
 *   - normBell:     Bell-curve centered on a target value
 *   - normLog:      Logarithmic (diminishing returns)
 *   - normZScore:   Z-score based (relative to population)
 *   - normInverse:  Inverted linear (higher raw = lower score)
 *   - normThreshold: Step function at a threshold
 *   - normClamped:  Clamped linear with soft cap
 */

// ─── Helpers ───────────────────────────────────────────────────

function isInvalid(v) {
  return v == null || !Number.isFinite(v);
}

/**
 * Clamp value between min and max.
 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ─── Normalizer: Linear ────────────────────────────────────────

/**
 * Linear normalization: score = (value - min) / (max - min) * 100
 * Clamped to [0, 100]. Higher raw = higher score.
 *
 * @param {number|null} value
 * @param {number} min — raw value mapping to score 0
 * @param {number} max — raw value mapping to score 100
 * @param {number} [lowerBound=min] — hard floor for clamping
 * @param {number} [upperBound=max] — hard ceiling for clamping
 * @returns {number} score 0–100
 */
export function normLinear(value, min, max, lowerBound = null, upperBound = null) {
  if (isInvalid(value)) return 0;
  if (max <= min) return 50;
  const lo = lowerBound ?? min;
  const hi = upperBound ?? max;
  const clamped = clamp(value, lo, hi);
  return Math.round(((clamped - min) / (max - min)) * 100);
}

// ─── Normalizer: Inverse Linear ────────────────────────────────

/**
 * Inverse linear: lower raw = higher score.
 * Good for metrics like drawdown where small is better.
 */
export function normInverse(value, min, max, lowerBound = null, upperBound = null) {
  if (isInvalid(value)) return 0;
  if (max <= min) return 50;
  const lo = lowerBound ?? min;
  const hi = upperBound ?? max;
  const clamped = clamp(value, lo, hi);
  return Math.round((1 - (clamped - min) / (max - min)) * 100);
}

// ─── Normalizer: Bell Curve ────────────────────────────────────

/**
 * Bell-curve normalization: peaks at `target`, falls off to both sides.
 * Good for metrics where moderate values are ideal (e.g. volatility).
 *
 * @param {number|null} value
 * @param {number} target — ideal value (peak of bell)
 * @param {number} spread — how wide the bell is (0.5 = tight, 2 = wide)
 * @param {number} [maxScore=100]
 * @returns {number}
 */
export function normBell(value, target, spread, maxScore = 100) {
  if (isInvalid(value)) return 0;
  const dist = Math.abs(value - target);
  const score = maxScore * Math.exp(-((dist / spread) ** 2) / 2);
  return Math.round(clamp(score, 0, maxScore));
}

// ─── Normalizer: Logarithmic ───────────────────────────────────

/**
 * Logarithmic normalization: diminishing returns as value grows.
 * Good for metrics like total fees where 10→100 is meaningful but 1000→10000 is not.
 *
 * @param {number|null} value
 * @param {number} floor — raw value below which score = 0
 * @param {number} cap — raw value above which score = 100
 * @param {number} [base=Math.E] — log base (higher = slower growth)
 * @returns {number}
 */
export function normLog(value, floor, cap, base = Math.E) {
  if (isInvalid(value)) return 0;
  if (value <= floor) return 0;
  if (value >= cap) return 100;
  const normalized = (value - floor) / (cap - floor);
  // Log transform: score grows fast initially, then plateaus
  const logVal = Math.log(1 + normalized * (base - 1)) / Math.log(base);
  return Math.round(clamp(logVal * 100, 0, 100));
}

// ─── Normalizer: Z-Score ───────────────────────────────────────

/**
 * Z-Score normalization: score relative to population statistics.
 * Requires mean and stdDev of the population.
 *
 * @param {number|null} value
 * @param {number} mean — population mean
 * @param {number} stdDev — population standard deviation
 * @param {boolean} [invert=false] — if true, lower z = higher score
 * @returns {number}
 */
export function normZScore(value, mean, stdDev, invert = false) {
  if (isInvalid(value) || stdDev <= 0) return 50;
  const z = (value - mean) / stdDev;
  // Map z-score [-3, +3] → [0, 100]. Most values fall in this range.
  const raw = invert ? -z : z;
  const score = (raw + 3) / 6 * 100;
  return Math.round(clamp(score, 0, 100));
}

// ─── Normalizer: Threshold ─────────────────────────────────────

/**
 * Step-function threshold: score = 100 if >= threshold, else 0.
 * Optional partial scoring before threshold.
 *
 * @param {number|null} value
 * @param {number} threshold — minimum value for full score
 * @param {boolean} [invert=false] — if true, score = 100 if <= threshold
 * @returns {number}
 */
export function normThreshold(value, threshold, invert = false) {
  if (isInvalid(value)) return 0;
  if (invert) return value <= threshold ? 100 : 0;
  return value >= threshold ? 100 : 0;
}

// ─── Normalizer: Ratio with Clamping ───────────────────────────

/**
 * Normalize a ratio (0–X) with diminishing returns after a target.
 * Good for ratios like fee/TVL, volume/TVL, etc.
 *
 * @param {number|null} value — ratio value
 * @param {number} target — ratio that maps to ~80% score
 * @param {number} [maxRatio=target * 3] — ratio that maps to 100%
 * @returns {number}
 */
export function normRatio(value, target, maxRatio = null) {
  if (isInvalid(value) || value === 0) return 0;
  const cap = maxRatio ?? target * 3;
  const normalized = clamp(value / target, 0, cap / target);
  // Logarithmic: fast growth to 80, then plateaus to 100
  if (normalized <= 1) return Math.round(normalized * 80);
  return Math.round(80 + Math.log10(normalized) * 20 / Math.log10(cap / target));
}

// ─── Composite Helpers ─────────────────────────────────────────

/**
 * Compute a Sharpe-like ratio from PnL data.
 * @param {number[]} returns — array of periodic returns
 * @param {number} [riskFreeRate=0] — risk-free rate per period
 * @returns {number|null}
 */
export function computeSharpeRatio(returns, riskFreeRate = 0) {
  if (!Array.isArray(returns) || returns.length < 5) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;
  return (mean - riskFreeRate) / stdDev;
}

/**
 * Compute Sortino ratio (uses downside deviation instead of total stdDev).
 * @param {number[]} returns
 * @param {number} [riskFreeRate=0]
 * @returns {number|null}
 */
export function computeSortinoRatio(returns, riskFreeRate = 0) {
  if (!Array.isArray(returns) || returns.length < 5) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return mean > 0 ? 999 : 0;
  const downsideVariance = downside.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return null;
  return (mean - riskFreeRate) / downsideDev;
}

/**
 * Compute Profit Factor.
 * @param {number} grossProfit
 * @param {number} grossLoss
 * @returns {number|null}
 */
export function computeProfitFactor(grossProfit, grossLoss) {
  if (grossLoss === 0) return grossProfit > 0 ? 999 : null;
  if (!Number.isFinite(grossProfit) || !Number.isFinite(grossLoss)) return null;
  return grossProfit / Math.abs(grossLoss);
}

/**
 * Compute max consecutive wins/losses from trade array.
 * @param {Array<{pnl: number}>} trades
 * @returns {{ bestStreak: number, worstStreak: number, currentStreak: number }}
 */
export function computeStreaks(trades) {
  let best = 0, worst = 0, current = 0;
  let currentBest = 0, currentWorst = 0;

  for (const t of trades) {
    if (t.pnl > 0) {
      currentBest++;
      currentWorst = 0;
      if (currentBest > best) best = currentBest;
      current = currentBest;
    } else if (t.pnl < 0) {
      currentWorst++;
      currentBest = 0;
      if (currentWorst > worst) worst = currentWorst;
      current = -currentWorst;
    }
  }

  return { bestStreak: best, worstStreak: worst, currentStreak: current };
}

export default {
  normLinear,
  normInverse,
  normBell,
  normLog,
  normZScore,
  normThreshold,
  normRatio,
  computeSharpeRatio,
  computeSortinoRatio,
  computeProfitFactor,
  computeStreaks,
};
