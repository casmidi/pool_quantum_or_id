/**
 * scoring/factors/pnl-factors.js
 * PnL scoring factors — evaluates wallet profit generation capability.
 *
 * Factors:
 *   - pnl_7d:        Profit/Loss last 7 days (recent performance)
 *   - pnl_30d:       Profit/Loss last 30 days (medium-term)
 *   - pnl_all:       Profit/Loss all-time (long-term track record)
 *   - profit_factor: Risk-adjusted win efficiency
 *   - sharpe_ratio:  Risk-adjusted return consistency
 *   - roi_7d:        Return on investment last 7 days
 *   - roi_30d:       Return on investment last 30 days
 */

import { normLinear, normLog, normBell, normZScore, computeSharpeRatio, computeSortinoRatio, computeProfitFactor } from "../normalizers.js";
import { log } from "../../logger.js";

const DEFAULT_THRESHOLDS = {
  // PnL thresholds (in SOL or USD — depends on input)
  pnl7dMin:      -50,
  pnl7dMax:      200,
  pnl30dMin:     -100,
  pnl30dMax:     500,
  pnlAllMin:     -200,
  pnlAllMax:     1000,
  // ROI thresholds (%)
  roi7dMin:      -50,
  roi7dMax:      150,
  roi30dMin:     -60,
  roi30dMax:     200,
  // Profit factor (gross profit / gross loss)
  profitFactorMin: 0,
  profitFactorMax: 5,
  // Sharpe ratio thresholds
  sharpeMin:     -2,
  sharpeMax:     5,
  // Return volatility (for consistency)
  returnConsistencyWeight: 0.15,
};

/**
 * Score 7-day PnL: recent profitability.
 * Higher recent PnL = higher score. Penalizes losses.
 */
function scorePnl7d(metrics, thresholds) {
  const raw = metrics.pnl7d;
  const score = normLog(raw, thresholds.pnl7dMin, thresholds.pnl7dMax, 3);
  return {
    name: "pnl_7d",
    score,
    raw: raw ?? 0,
    reason: raw != null
      ? (raw >= 0 ? `${raw.toFixed(2)} SOL (7d profit)` : `${raw.toFixed(2)} SOL (7d loss)`)
      : "no data",
    sentiment: raw >= 10 ? "good" : raw >= 0 ? "neutral" : "bad",
  };
}

/**
 * Score 30-day PnL: medium-term performance.
 * More weight on positive values.
 */
function scorePnl30d(metrics, thresholds) {
  const raw = metrics.pnl30d;
  const score = normLog(raw, thresholds.pnl30dMin, thresholds.pnl30dMax, 3);
  return {
    name: "pnl_30d",
    score,
    raw: raw ?? 0,
    reason: raw != null
      ? (raw >= 0 ? `${raw.toFixed(2)} SOL (30d profit)` : `${raw.toFixed(2)} SOL (30d loss)`)
      : "no data",
    sentiment: raw >= 50 ? "good" : raw >= 0 ? "neutral" : "bad",
  };
}

/**
 * Score all-time PnL: long-term track record.
 * Rewards sustained profitability.
 */
function scorePnlAll(metrics, thresholds) {
  const raw = metrics.pnlAll ?? metrics.pnl30d; // fallback to 30d if no all-time data
  const score = normLog(raw, thresholds.pnlAllMin, thresholds.pnlAllMax, 2);
  return {
    name: "pnl_all",
    score,
    raw: raw ?? 0,
    reason: raw != null
      ? (raw >= 0 ? `${raw.toFixed(2)} SOL (all-time)` : `${raw.toFixed(2)} SOL (all-time loss)`)
      : "no data",
    sentiment: raw >= 100 ? "good" : raw >= 0 ? "neutral" : "bad",
  };
}

/**
 * Score profit factor: gross profit / gross loss.
 * > 1.5 = excellent, > 1.0 = decent, < 1.0 = losing money.
 */
function scoreProfitFactor(metrics, thresholds) {
  let raw = metrics.profitFactor;
  if (raw == null && metrics.wins != null && metrics.losses != null && metrics.losses > 0) {
    // Estimate from trade counts if exact PnL not available
    raw = metrics.wins / Math.max(1, metrics.losses);
  }
  const score = normLog(raw, thresholds.profitFactorMin, thresholds.profitFactorMax, 3);
  return {
    name: "profit_factor",
    score,
    raw: raw ?? 0,
    reason: raw != null
      ? (raw >= 2 ? `${raw.toFixed(2)}x (excellent)` : raw >= 1.5 ? `${raw.toFixed(2)}x (strong)` : raw >= 1 ? `${raw.toFixed(2)}x (breakeven)` : `${raw.toFixed(2)}x (unprofitable)`)
      : "no data",
    sentiment: raw >= 2 ? "good" : raw >= 1 ? "neutral" : "bad",
  };
}

/**
 * Score Sharpe ratio: risk-adjusted returns.
 * > 2 = excellent, > 1 = good, > 0 = acceptable, < 0 = bad.
 */
function scoreSharpeRatio(metrics, thresholds) {
  let raw = metrics.sharpeRatio;
  if (raw == null && metrics.pnl7d != null && metrics.pnl30d != null) {
    // Estimate from available data
    const returns = [metrics.pnl7d / 7 || 0, metrics.pnl30d / 30 || 0, (metrics.pnl30d - (metrics.pnl7d ?? 0)) / 23 || 0];
    raw = computeSharpeRatio(returns);
    if (raw != null) raw = parseFloat(raw.toFixed(2));
  }
  const score = normBell(raw, 2, 2, 100);
  return {
    name: "sharpe_ratio",
    score,
    raw: raw ?? 0,
    reason: raw != null
      ? (raw >= 2 ? `${raw.toFixed(2)} (excellent risk-adjusted)`
        : raw >= 1 ? `${raw.toFixed(2)} (good risk-adjusted)`
        : raw >= 0 ? `${raw.toFixed(2)} (acceptable)`
        : `${raw.toFixed(2)} (poor risk-adjusted)`)
      : "insufficient data",
    sentiment: raw >= 2 ? "good" : raw >= 0 ? "neutral" : "bad",
  };
}

/**
 * Score ROI 7d + 30d.
 */
function scoreRoi(metrics, thresholds) {
  const roi7d = metrics.roi7dPct;
  const roi30d = metrics.roi30dPct;

  const score7d = roi7d != null ? normBell(roi7d, 30, 40, 50) : 0;
  const score30d = roi30d != null ? normBell(roi30d, 50, 60, 50) : 0;
  const combined = Math.round((score7d + score30d) / (roi7d != null && roi30d != null ? 2 : (roi7d != null ? 1 : 1)));

  return {
    name: "roi",
    score: combined,
    raw: { roi7d, roi30d },
    reason: roi7d != null
      ? `ROI 7d=${roi7d.toFixed(1)}%, 30d=${roi30d?.toFixed(1) ?? "N/A"}%`
      : "no ROI data",
    sentiment: combined >= 60 ? "good" : combined >= 30 ? "neutral" : "bad",
  };
}

/**
 * Run all PnL factors for a wallet.
 * @param {object} metrics — WalletMetrics
 * @param {object} [thresholds] — overrides
 * @returns {object} — { [factorName]: FactorResult }
 */
export function scorePnlFactors(metrics, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    pnl_7d:        scorePnl7d(metrics, t),
    pnl_30d:       scorePnl30d(metrics, t),
    pnl_all:       scorePnlAll(metrics, t),
    profit_factor: scoreProfitFactor(metrics, t),
    sharpe_ratio:  scoreSharpeRatio(metrics, t),
    roi:           scoreRoi(metrics, t),
  };
}

export const FACTOR_META = {
  pnl_7d:        { group: "pnl", description: "7-day profit/loss", defaultWeight: 0.15 },
  pnl_30d:       { group: "pnl", description: "30-day profit/loss", defaultWeight: 0.12 },
  pnl_all:       { group: "pnl", description: "All-time profit/loss", defaultWeight: 0.08 },
  profit_factor: { group: "pnl", description: "Gross profit / gross loss ratio", defaultWeight: 0.10 },
  sharpe_ratio:  { group: "pnl", description: "Risk-adjusted return consistency", defaultWeight: 0.08 },
  roi:           { group: "pnl", description: "Return on investment (7d+30d)", defaultWeight: 0.07 },
};
