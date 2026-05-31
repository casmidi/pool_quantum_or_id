/**
 * scoring/factors/risk-factors.js
 * Risk scoring factors — evaluates wallet risk management capability.
 *
 * Factors:
 *   - max_drawdown:     Maximum peak-to-trough decline
 *   - avg_drawdown:     Average drawdown across positions
 *   - recovery_speed:   How quickly wallet recovers from losses
 *   - risk_adjusted:    Composite risk score (drawdown + recovery + consistency)
 *   - win_rate:         Win rate (with risk context)
 *   - loss_aversion:    Ability to cut losses quickly
 */

import { normInverse, normLinear, normBell, normLog } from "../normalizers.js";
import { log } from "../../logger.js";

const DEFAULT_THRESHOLDS = {
  maxDrawdownMin:  0,    // 0% drawdown = perfect
  maxDrawdownMax:  60,   // 60%+ drawdown = terrible
  avgDrawdownMax:  30,   // 30%+ avg drawdown = bad
  winRateMin:      30,   // 30% win rate floor
  winRateMax:      95,   // 95% win rate ceiling
  recoveryMin:     0,    // recovery factor floor
  recoveryMax:     10,   // recovery factor ceiling
  idealLossSize:   5,    // target loss size as % of portfolio (smaller = better)
};

/**
 * Score max drawdown — lower is better.
 */
function scoreMaxDrawdown(metrics, thresholds) {
  const raw = metrics.maxDrawdownPct ?? 0;
  const score = normInverse(raw, thresholds.maxDrawdownMin, thresholds.maxDrawdownMax);
  return {
    name: "max_drawdown",
    score,
    raw,
    reason: raw != null
      ? (raw <= 10 ? `${raw.toFixed(1)}% (excellent risk control)`
        : raw <= 25 ? `${raw.toFixed(1)}% (moderate risk)`
        : raw <= 40 ? `${raw.toFixed(1)}% (high risk)`
        : `${raw.toFixed(1)}% (extreme risk)`)
      : "no data",
    sentiment: raw <= 15 ? "good" : raw <= 30 ? "neutral" : "bad",
  };
}

/**
 * Score average drawdown — lower is better.
 */
function scoreAvgDrawdown(metrics, thresholds) {
  const raw = metrics.avgDrawdownPct ?? metrics.maxDrawdownPct;
  if (raw == null) {
    return { name: "avg_drawdown", score: 50, raw: 0, reason: "estimated from max drawdown", sentiment: "neutral" };
  }
  const score = normInverse(raw, 0, thresholds.avgDrawdownMax);
  return {
    name: "avg_drawdown",
    score,
    raw,
    reason: `${raw.toFixed(1)}% avg drawdown`,
    sentiment: raw <= 10 ? "good" : raw <= 20 ? "neutral" : "bad",
  };
}

/**
 * Score recovery speed — how quickly wallet recovers from drawdowns.
 * Higher recovery factor = faster recovery.
 */
function scoreRecoverySpeed(metrics, thresholds) {
  const raw = metrics.recoveryFactor ?? null;
  if (raw == null) {
    // Estimate from win rate and avg PnL
    const winRate = metrics.winRate ?? 50;
    const estimated = winRate > 60 ? 5 : winRate > 45 ? 3 : 1;
    return {
      name: "recovery_speed",
      score: normLinear(estimated, thresholds.recoveryMin, thresholds.recoveryMax),
      raw: estimated,
      reason: `estimated recovery ${estimated.toFixed(1)}x (from win rate ${winRate}%)`,
      sentiment: estimated >= 4 ? "good" : estimated >= 2 ? "neutral" : "bad",
    };
  }
  const score = normLinear(raw, thresholds.recoveryMin, thresholds.recoveryMax);
  return {
    name: "recovery_speed",
    score,
    raw,
    reason: raw >= 5 ? `${raw.toFixed(1)}x (fast recovery)` : raw >= 2 ? `${raw.toFixed(1)}x (moderate)` : `${raw.toFixed(1)}x (slow recovery)`,
    sentiment: raw >= 5 ? "good" : raw >= 2 ? "neutral" : "bad",
  };
}

/**
 * Score win rate — higher is better, but penalize extremely high win rates
 * that indicate risk-averse behavior (missing big opportunities).
 */
function scoreWinRate(metrics, thresholds) {
  const raw = metrics.winRate ?? 0;
  // Bell curve: ideal win rate is ~70-85% for LP
  // Very high (>95%) = too conservative, very low (<40%) = not profitable
  const score = normBell(raw, 75, 22, 100);
  return {
    name: "win_rate",
    score,
    raw,
    reason: raw >= 85 ? `${raw.toFixed(1)}% (very high — may be too conservative)`
      : raw >= 70 ? `${raw.toFixed(1)}% (excellent)`
      : raw >= 55 ? `${raw.toFixed(1)}% (good)`
      : raw >= 40 ? `${raw.toFixed(1)}% (moderate)`
      : `${raw.toFixed(1)}% (low)`,
    sentiment: raw >= 70 ? "good" : raw >= 45 ? "neutral" : "bad",
  };
}

/**
 * Score loss aversion — average loss size as % of typical win.
 * Small losses relative to wins = good risk management.
 */
function scoreLossAversion(metrics, thresholds) {
  const winRate = metrics.winRate ?? 50;
  const profitFactor = metrics.profitFactor;
  let raw = metrics.avgLossSizePct ?? null;

  if (raw == null && profitFactor != null && winRate > 0) {
    // Estimate: avg_loss = avg_win / profitFactor
    const estAvgWin = 100; // assume normalized
    raw = profitFactor > 0 ? estAvgWin / profitFactor : estAvgWin;
  }

  if (raw == null) {
    return { name: "loss_aversion", score: 50, raw: 0, reason: "insufficient data", sentiment: "neutral" };
  }

  // Smaller losses relative to wins = better
  const score = normInverse(raw, 0, 100);
  return {
    name: "loss_aversion",
    score,
    raw,
    reason: raw <= 30 ? `avg loss ${raw.toFixed(0)}% of win (tight risk control)` : `${raw.toFixed(0)}% of win`,
    sentiment: raw <= 40 ? "good" : raw <= 70 ? "neutral" : "bad",
  };
}

/**
 * Run all Risk factors for a wallet.
 */
export function scoreRiskFactors(metrics, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    max_drawdown:    scoreMaxDrawdown(metrics, t),
    avg_drawdown:    scoreAvgDrawdown(metrics, t),
    recovery_speed:  scoreRecoverySpeed(metrics, t),
    win_rate:        scoreWinRate(metrics, t),
    loss_aversion:   scoreLossAversion(metrics, t),
  };
}

export const FACTOR_META = {
  max_drawdown:   { group: "risk", description: "Maximum peak-to-trough decline", defaultWeight: 0.12 },
  avg_drawdown:   { group: "risk", description: "Average drawdown across positions", defaultWeight: 0.06 },
  recovery_speed: { group: "risk", description: "Recovery speed after losses", defaultWeight: 0.06 },
  win_rate:       { group: "risk", description: "Win rate (with risk context)", defaultWeight: 0.10 },
  loss_aversion:  { group: "risk", description: "Ability to cut losses quickly", defaultWeight: 0.06 },
};
