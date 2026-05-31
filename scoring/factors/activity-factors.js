/**
 * scoring/factors/activity-factors.js
 * Activity scoring factors — evaluates wallet engagement and consistency.
 *
 * Factors:
 *   - consistency:     Days active in last 30 (reliable operator)
 *   - longevity:       Total days since first activity (trusted track record)
 *   - engagement:      Average daily interactions (swaps + deposits + withdrawals)
 *   - position_depth:  Number of concurrent positions (capital deployment breadth)
 */

import { normLinear, normInverse, normLog, normBell } from "../normalizers.js";
import { log } from "../../logger.js";

const DEFAULT_THRESHOLDS = {
  consistencyMin:  0,    // 0 days active
  consistencyMax:  30,   // 30 days active = perfect
  longevityMin:    1,    // 1 day old
  longevityMax:    180,  // 180+ days = established
  engagementMin:   0,    // 0 interactions/day
  engagementMax:   20,   // 20+ interactions/day = highly active
  positionDepthMin: 0,   // 0 positions
  positionDepthMax: 15,  // 15+ positions = deep diversified
};

/**
 * Score consistency — days active in last 30 days.
 * Higher = more reliable LP activity.
 */
function scoreConsistency(metrics, thresholds) {
  let raw = metrics.daysActive30d;
  if (raw == null) {
    // Estimate from PnL data availability
    raw = (metrics.pnl7d != null || metrics.pnl30d != null) ? 15 : 0;
  }
  const score = normLinear(raw, thresholds.consistencyMin, thresholds.consistencyMax);
  return {
    name: "consistency",
    score,
    raw,
    reason: raw >= 25 ? `${raw}/30 days (highly consistent)`
      : raw >= 15 ? `${raw}/30 days (moderately consistent)`
      : raw >= 5 ? `${raw}/30 days (sporadic)`
      : `${raw}/30 days (inactive)`,
    sentiment: raw >= 20 ? "good" : raw >= 10 ? "neutral" : "bad",
  };
}

/**
 * Score longevity — how long the wallet has been active.
 * Longer track record = more trustworthy.
 */
function scoreLongevity(metrics, thresholds) {
  const raw = metrics.walletAge ?? metrics.totalDaysActive ?? 0;
  // Log scale: 1 day → 0, 7 days → ~30, 30 days → ~60, 180 days → 100
  const score = normLog(raw, thresholds.longevityMin, thresholds.longevityMax, 4);
  return {
    name: "longevity",
    score,
    raw,
    reason: raw >= 180 ? `${raw.toFixed(0)} days (well-established)`
      : raw >= 60 ? `${raw.toFixed(0)} days (proven track record)`
      : raw >= 14 ? `${raw.toFixed(0)} days (new but active)`
      : `${raw.toFixed(0)} days (very new)`,
    sentiment: raw >= 90 ? "good" : raw >= 30 ? "neutral" : "bad",
  };
}

/**
 * Score engagement — average daily interactions.
 * Measures operational intensity.
 */
function scoreEngagement(metrics, thresholds) {
  const deposits = metrics.depositCount ?? 0;
  const withdrawals = metrics.withdrawalCount ?? 0;
  const swaps = metrics.swapCount ?? 0;
  const totalTx = deposits + withdrawals + swaps;
  const daysActive = Math.max(1, metrics.daysActive30d ?? metrics.totalDaysActive ?? 1);
  const raw = totalTx / daysActive;

  // Bell curve: moderate engagement is ideal (5-10 tx/day)
  // Very low = inactive, very high = could be bot/farmer
  const score = normBell(raw, 8, 6, 100);
  return {
    name: "engagement",
    score,
    raw: parseFloat(raw.toFixed(2)),
    reason: raw >= 15 ? `${raw.toFixed(1)} tx/day (high frequency)`
      : raw >= 5 ? `${raw.toFixed(1)} tx/day (active)`
      : raw >= 1 ? `${raw.toFixed(1)} tx/day (moderate)`
      : `${raw.toFixed(1)} tx/day (low)`,
    sentiment: raw >= 3 && raw <= 15 ? "good" : raw > 0 ? "neutral" : "bad",
  };
}

/**
 * Score position depth — number of concurrent positions.
 * Diversification across multiple pools is good.
 */
function scorePositionDepth(metrics, thresholds) {
  // Use available position counts from various sources
  const raw = metrics.positionCount
    ?? metrics.activePositionCount
    ?? (metrics.depositCount - (metrics.withdrawalCount ?? 0))
    ?? 1;

  // Bell curve: 5-10 positions = ideal diversification
  // < 2 = not enough diversity, > 15 = may be over-diversified/farming
  const score = normBell(raw, 7, 5, 100);
  return {
    name: "position_depth",
    score,
    raw,
    reason: raw >= 10 ? `${raw} positions (well-diversified)`
      : raw >= 5 ? `${raw} positions (good diversity)`
      : raw >= 2 ? `${raw} positions (limited diversity)`
      : `${raw} position (concentrated)`,
    sentiment: raw >= 4 && raw <= 12 ? "good" : raw >= 2 ? "neutral" : "bad",
  };
}

/**
 * Run all Activity factors for a wallet.
 */
export function scoreActivityFactors(metrics, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    consistency:     scoreConsistency(metrics, t),
    longevity:       scoreLongevity(metrics, t),
    engagement:      scoreEngagement(metrics, t),
    position_depth:  scorePositionDepth(metrics, t),
  };
}

export const FACTOR_META = {
  consistency:     { group: "activity", description: "Days active in last 30 days", defaultWeight: 0.08 },
  longevity:       { group: "activity", description: "Wallet age/track record length", defaultWeight: 0.06 },
  engagement:      { group: "activity", description: "Average daily LP interactions", defaultWeight: 0.04 },
  position_depth:  { group: "activity", description: "Number of concurrent positions", defaultWeight: 0.04 },
};
