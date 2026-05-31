/**
 * scoring/factors/liquidity-factors.js
 * Liquidity scoring factors — evaluates wallet's LP efficiency and fee generation.
 *
 * Factors:
 *   - fee_apr:          Fee APR earned on LP positions
 *   - fee_tvl_ratio:    Fee / active TVL ratio (efficiency)
 *   - il_management:    Impermanent loss management score
 *   - range_efficiency: How efficiently bins are utilized
 *   - bin_utilization:  Active bins vs total bins ratio
 *   - volume_capture:   LP volume capture relative to pool volume
 */

import { normLinear, normInverse, normBell, normLog, normRatio } from "../normalizers.js";

const DEFAULT_THRESHOLDS = {
  feeAprMin:    0,     // 0% APR floor
  feeAprMax:    120,   // 120%+ APR ceiling
  feeRatioMin:  0,     // fee/TVL ratio floor
  feeRatioMax:  0.15,  // fee/TVL ratio ceiling
  ilScoreMin:   0,     // IL management floor
  ilScoreMax:   100,   // IL management ceiling
  rangeEffMin:  0,
  rangeEffMax:  100,
  binUtilMin:   0,
  binUtilMax:   100,
  volumeCaptureMin: 0,
  volumeCaptureMax: 500, // in SOL
};

/**
 * Score fee APR — higher is better for LP profitability.
 * Uses bell curve to penalize extreme APRs (>80% may be unsustainable).
 */
function scoreFeeApr(metrics, thresholds) {
  const raw = metrics.feeApr ?? null;
  if (raw == null) {
    // Estimate from fees earned vs portfolio size
    const fees = metrics.feesEarned ?? 0;
    const volume = metrics.lpVolumeSol ?? 100;
    const estimatedApr = volume > 0 ? (fees / volume) * 365 * 100 : 0;
    const score = normBell(estimatedApr, 40, 35, 100);
    return {
      name: "fee_apr",
      score,
      raw: parseFloat(estimatedApr.toFixed(2)),
      reason: `~${estimatedApr.toFixed(1)}% est. APR (from ${fees.toFixed(2)} SOL fees)`,
      sentiment: estimatedApr >= 30 ? "good" : estimatedApr >= 10 ? "neutral" : "bad",
    };
  }
  const score = normBell(raw, 40, 35, 100);
  return {
    name: "fee_apr",
    score,
    raw,
    reason: raw >= 60 ? `${raw.toFixed(1)}% APR (strong fee generation)`
      : raw >= 30 ? `${raw.toFixed(1)}% APR (good)`
      : raw >= 10 ? `${raw.toFixed(1)}% APR (moderate)`
      : `${raw.toFixed(1)}% APR (low)`,
    sentiment: raw >= 30 ? "good" : raw >= 10 ? "neutral" : "bad",
  };
}

/**
 * Score fee/TVL ratio — fee efficiency.
 * Higher ratio = more fee income relative to capital deployed.
 */
function scoreFeeTvlRatio(metrics, thresholds) {
  let raw = metrics.feeActiveTvlRatio ?? metrics.fee_tvl_ratio ?? null;
  if (raw == null) {
    // Estimate from fees and LP volume
    const fees = metrics.feesEarned ?? 0;
    const volume = metrics.lpVolumeSol ?? 100;
    raw = volume > 0 ? fees / volume : 0;
  }
  const score = normRatio(raw, 0.02, 0.15);
  return {
    name: "fee_tvl_ratio",
    score,
    raw: parseFloat(raw.toFixed(4)),
    reason: raw >= 0.05 ? `${(raw * 100).toFixed(2)}% (high efficiency)`
      : raw >= 0.02 ? `${(raw * 100).toFixed(2)}% (decent efficiency)`
      : `${(raw * 100).toFixed(2)}% (low efficiency)`,
    sentiment: raw >= 0.03 ? "good" : raw >= 0.01 ? "neutral" : "bad",
  };
}

/**
 * Score IL management — how well wallet manages impermanent loss.
 * Estimated from drawdown and fees ratio.
 */
function scoreIlManagement(metrics, thresholds) {
  const maxDD = metrics.maxDrawdownPct ?? 0;
  const fees = metrics.feesEarned ?? 0;
  const volume = metrics.lpVolumeSol ?? 1;

  // IL is bad when drawdown > fees earned
  if (maxDD > 0 && fees > 0) {
    const feeCushion = fees / Math.max(1, maxDD * volume / 100);
    const raw = Math.min(100, feeCushion * 50);
    const score = normLinear(raw, thresholds.ilScoreMin, thresholds.ilScoreMax);
    return {
      name: "il_management",
      score,
      raw: parseFloat(raw.toFixed(1)),
      reason: feeCushion >= 2 ? `Fees ${feeCushion.toFixed(1)}x > DD (well-hedged)`
        : feeCushion >= 1 ? `Fees cover DD (adequate)`
        : `DD exceeds fee income (vulnerable)`,
      sentiment: raw >= 60 ? "good" : raw >= 30 ? "neutral" : "bad",
    };
  }

  return {
    name: "il_management",
    score: maxDD <= 10 ? 80 : maxDD <= 30 ? 50 : 20,
    raw: maxDD,
    reason: maxDD <= 10 ? "Low drawdown, good IL management" : "Significant drawdown risk",
    sentiment: maxDD <= 15 ? "good" : maxDD <= 30 ? "neutral" : "bad",
  };
}

/**
 * Score range efficiency — how well bins are positioned.
 */
function scoreRangeEfficiency(metrics, thresholds) {
  const raw = metrics.rangeEfficiency ?? metrics.binUtilization ?? null;
  if (raw == null) {
    return { name: "range_efficiency", score: 50, raw: 0, reason: "insufficient data", sentiment: "neutral" };
  }
  const score = normBell(raw, 75, 25, 100);
  return {
    name: "range_efficiency",
    score,
    raw,
    reason: raw >= 75 ? `${raw.toFixed(0)}% (well-positioned)`
      : raw >= 50 ? `${raw.toFixed(0)}% (adequate)`
      : `${raw.toFixed(0)}% (poor range selection)`,
    sentiment: raw >= 65 ? "good" : raw >= 40 ? "neutral" : "bad",
  };
}

/**
 * Score volume capture — liquidity provision volume.
 */
function scoreVolumeCapture(metrics, thresholds) {
  const raw = metrics.lpVolumeSol ?? 0;
  const score = normLog(raw, thresholds.volumeCaptureMin, thresholds.volumeCaptureMax, 3);
  return {
    name: "volume_capture",
    score,
    raw,
    reason: raw >= 100 ? `${raw.toFixed(0)} SOL (high volume)` : `${raw.toFixed(0)} SOL`,
    sentiment: raw >= 50 ? "good" : raw >= 10 ? "neutral" : "bad",
  };
}

/**
 * Run all Liquidity factors for a wallet.
 */
export function scoreLiquidityFactors(metrics, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    fee_apr:           scoreFeeApr(metrics, t),
    fee_tvl_ratio:     scoreFeeTvlRatio(metrics, t),
    il_management:     scoreIlManagement(metrics, t),
    range_efficiency:  scoreRangeEfficiency(metrics, t),
    volume_capture:    scoreVolumeCapture(metrics, t),
  };
}

export const FACTOR_META = {
  fee_apr:           { group: "liquidity", description: "Fee APR earned on LP", defaultWeight: 0.10 },
  fee_tvl_ratio:     { group: "liquidity", description: "Fee income vs TVL efficiency", defaultWeight: 0.08 },
  il_management:     { group: "liquidity", description: "Impermanent loss management", defaultWeight: 0.06 },
  range_efficiency:  { group: "liquidity", description: "Bin range positioning quality", defaultWeight: 0.05 },
  volume_capture:    { group: "liquidity", description: "LP volume captured", defaultWeight: 0.04 },
};
