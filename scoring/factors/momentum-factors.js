/**
 * scoring/factors/momentum-factors.js
 * Momentum scoring factors — evaluates wallet's recent performance trajectory.
 *
 * Factors:
 *   - hot_streak:      Recent consecutive wins (momentum signal)
 *   - pnl_trend:       PnL trend direction (improving/declining)
 *   - volatility_adapt: How well wallet performs in varying volatility
 *   - recency_weight:  Recency-weighted performance (recent data matters more)
 */

import { normLinear, normBell, normLog, computeStreaks } from "../normalizers.js";

const DEFAULT_THRESHOLDS = {
  streakMin:  -5,    // -5 consecutive losses
  streakMax:  10,    // 10+ consecutive wins
  pnlTrendMin: -100, // sharply declining
  pnlTrendMax: 200,  // sharply improving
  recencyDecay: 0.7, // weight decay factor for older data
};

/**
 * Score hot streak — current winning/losing streak.
 * Winning streaks indicate momentum; losing streaks indicate problems.
 * Bell curve centered on positive streaks (3-5 wins ideal).
 */
function scoreHotStreak(metrics, thresholds) {
  const raw = metrics.streakCurrent ?? 0;
  // Map streak to score: +3 wins = 100, 0 = 50, -3 losses = 0
  const score = normBell(raw, 4, 4, 100);
  return {
    name: "hot_streak",
    score,
    raw,
    reason: raw >= 5 ? `${raw} wins (hot streak 🔥)`
      : raw >= 3 ? `${raw} wins (building momentum)`
      : raw >= 0 ? `no streak`
      : raw >= -2 ? `${Math.abs(raw)} losses (slight dip)`
      : `${Math.abs(raw)} losses (losing streak ⚠️)`,
    sentiment: raw >= 3 ? "good" : raw >= -1 ? "neutral" : "bad",
  };
}

/**
 * Score PnL trend — compare 7d vs 30d performance.
 * If 7d PnL > 30d/30*7 = recent improvement.
 */
function scorePnlTrend(metrics, thresholds) {
  const pnl7d = metrics.pnl7d;
  const pnl30d = metrics.pnl30d;

  if (pnl7d == null || pnl30d == null) {
    return {
      name: "pnl_trend",
      score: 50,
      raw: 0,
      reason: "insufficient data",
      sentiment: "neutral",
    };
  }

  // Normalize: 7d annualized vs 30d annualized
  const daily7d = pnl7d / 7;
  const daily30d = pnl30d / 30;
  const trend = daily7d - daily30d; // positive = improving

  const score = normBell(trend, 2, 5, 100);
  return {
    name: "pnl_trend",
    score,
    raw: parseFloat(trend.toFixed(3)),
    reason: trend > 0 ? `Improving (+${trend.toFixed(3)} SOL/day vs 30d avg)`
      : trend < 0 ? `Declining (${trend.toFixed(3)} SOL/day vs 30d avg)`
      : "Stable",
    sentiment: trend > 0 ? "good" : trend >= -1 ? "neutral" : "bad",
  };
}

/**
 * Score volatility adaptation — win rate in volatile vs stable conditions.
 * Estimated from profit factor and drawdown relationship.
 */
function scoreVolatilityAdapt(metrics, thresholds) {
  const winRate = metrics.winRate ?? 50;
  const maxDD = metrics.maxDrawdownPct ?? 0;
  const profitFactor = metrics.profitFactor ?? 1;

  // Good volatility adaptation = high win rate + low drawdown + high profit factor
  const compositeScore = (winRate * 0.4) + ((100 - maxDD * 2) * 0.3) + (Math.min(100, profitFactor * 20) * 0.3);
  const score = Math.round(Math.min(100, compositeScore));
  return {
    name: "volatility_adapt",
    score,
    raw: { winRate, maxDD, profitFactor },
    reason: score >= 70 ? `Adapts well (WR=${winRate.toFixed(0)}%, DD=${maxDD.toFixed(1)}%)`
      : score >= 40 ? `Moderate adaptation`
      : `Poor adaptation to volatility`,
    sentiment: score >= 65 ? "good" : score >= 35 ? "neutral" : "bad",
  };
}

/**
 * Score best known streak — historical best winning streak as sign of peak performance.
 */
function scoreBestStreak(metrics, thresholds) {
  const raw = metrics.streakBest ?? null;
  if (raw == null) {
    return { name: "best_streak", score: 50, raw: 0, reason: "no data", sentiment: "neutral" };
  }
  const score = normLog(raw, 0, 15, 3);
  return {
    name: "best_streak",
    score,
    raw,
    reason: raw >= 10 ? `${raw} best streak (peak performer)`
      : raw >= 5 ? `${raw} best streak (strong)`
      : `${raw} best streak`,
    sentiment: raw >= 5 ? "good" : raw >= 2 ? "neutral" : "bad",
  };
}

/**
 * Run all Momentum factors for a wallet.
 */
export function scoreMomentumFactors(metrics, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    hot_streak:       scoreHotStreak(metrics, t),
    pnl_trend:        scorePnlTrend(metrics, t),
    volatility_adapt: scoreVolatilityAdapt(metrics, t),
    best_streak:      scoreBestStreak(metrics, t),
  };
}

export const FACTOR_META = {
  hot_streak:       { group: "momentum", description: "Current winning/losing streak", defaultWeight: 0.06 },
  pnl_trend:        { group: "momentum", description: "PnL trend direction (7d vs 30d)", defaultWeight: 0.06 },
  volatility_adapt: { group: "momentum", description: "Performance in varying volatility", defaultWeight: 0.04 },
  best_streak:      { group: "momentum", description: "Best historical winning streak", defaultWeight: 0.03 },
};
