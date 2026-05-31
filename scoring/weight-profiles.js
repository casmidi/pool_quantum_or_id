/**
 * scoring/weight-profiles.js
 * Strategy mode weight profiles for the Multi-Layer Scoring Engine.
 *
 * 5 modes:
 *   conservative — Safety-first: prioritizes win rate, drawdown, consistency
 *   balanced     — Default: even mix of growth and safety
 *   aggressive   — Growth-first: prioritizes PnL, momentum, fee generation
 *   momentum     — Trend-following: prioritizes recent streaks, hot wallets
 *   hybrid       — Smart adaptive: weights shift based on market regime
 *
 * Each profile defines weights for ALL scoring factors. Weights must sum to ~1.0.
 */

/**
 * @typedef {object} WeightProfile
 * @property {string} label — Display name
 * @property {string} description — Human-readable explanation
 * @property {string} riskProfile — "low" | "medium" | "high"
 * @property {object} weights — { factorName: number } summing to ~1.0
 */

/** @type {Object<string, WeightProfile>} */
export const WEIGHT_PROFILES = {
  // ─── Conservative ───────────────────────────────────────────
  conservative: {
    label: "Conservative",
    description: "Safety-first — prioritizes capital preservation and consistent returns",
    riskProfile: "low",
    weights: {
      // PnL factors (total: 0.28)
      pnl_7d:        0.06,
      pnl_30d:       0.06,
      pnl_all:       0.04,
      profit_factor: 0.06,
      sharpe_ratio:  0.04,
      roi:           0.02,
      // Risk factors (total: 0.38)
      max_drawdown:      0.14,
      avg_drawdown:      0.06,
      recovery_speed:    0.06,
      win_rate:          0.08,
      loss_aversion:     0.04,
      // Activity factors (total: 0.14)
      consistency:    0.06,
      longevity:      0.04,
      engagement:     0.02,
      position_depth: 0.02,
      // Liquidity factors (total: 0.10)
      fee_apr:          0.03,
      fee_tvl_ratio:    0.02,
      il_management:    0.03,
      range_efficiency: 0.01,
      volume_capture:   0.01,
      // Momentum factors (total: 0.04)
      hot_streak:       0.01,
      pnl_trend:        0.01,
      volatility_adapt: 0.01,
      best_streak:      0.01,
      // Fingerprint factors (total: 0.06)
      archetype:            0.02,
      capital_efficiency:   0.01,
      behavior_consistency: 0.01,
      authenticity:         0.02,
    },
  },

  // ─── Balanced ───────────────────────────────────────────────
  balanced: {
    label: "Balanced",
    description: "Default — even mix of growth potential and risk management",
    riskProfile: "medium",
    weights: {
      // PnL factors (total: 0.40)
      pnl_7d:        0.10,
      pnl_30d:       0.08,
      pnl_all:       0.05,
      profit_factor: 0.07,
      sharpe_ratio:  0.05,
      roi:           0.05,
      // Risk factors (total: 0.22)
      max_drawdown:      0.08,
      avg_drawdown:      0.03,
      recovery_speed:    0.03,
      win_rate:          0.06,
      loss_aversion:     0.02,
      // Activity factors (total: 0.12)
      consistency:    0.05,
      longevity:      0.03,
      engagement:     0.02,
      position_depth: 0.02,
      // Liquidity factors (total: 0.12)
      fee_apr:          0.04,
      fee_tvl_ratio:    0.03,
      il_management:    0.03,
      range_efficiency: 0.01,
      volume_capture:   0.01,
      // Momentum factors (total: 0.06)
      hot_streak:       0.02,
      pnl_trend:        0.02,
      volatility_adapt: 0.01,
      best_streak:      0.01,
      // Fingerprint factors (total: 0.08)
      archetype:            0.03,
      capital_efficiency:   0.02,
      behavior_consistency: 0.01,
      authenticity:         0.02,
    },
  },

  // ─── Aggressive ─────────────────────────────────────────────
  aggressive: {
    label: "Aggressive",
    description: "Growth-first — prioritizes PnL, momentum, and high fee generation",
    riskProfile: "high",
    weights: {
      // PnL factors (total: 0.52) ← heavily weighted
      pnl_7d:        0.16,
      pnl_30d:       0.12,
      pnl_all:       0.06,
      profit_factor: 0.08,
      sharpe_ratio:  0.05,
      roi:           0.05,
      // Risk factors (total: 0.10) ← de-emphasized
      max_drawdown:      0.03,
      avg_drawdown:     0.01,
      recovery_speed:   0.01,
      win_rate:         0.03,
      loss_aversion:    0.02,
      // Activity factors (total: 0.10)
      consistency:    0.04,
      longevity:      0.02,
      engagement:     0.02,
      position_depth: 0.02,
      // Liquidity factors (total: 0.12)
      fee_apr:          0.05,
      fee_tvl_ratio:    0.03,
      il_management:    0.02,
      range_efficiency: 0.01,
      volume_capture:   0.01,
      // Momentum factors (total: 0.08) ← boosted
      hot_streak:       0.03,
      pnl_trend:        0.03,
      volatility_adapt: 0.01,
      best_streak:      0.01,
      // Fingerprint factors (total: 0.08)
      archetype:            0.03,
      capital_efficiency:   0.02,
      behavior_consistency: 0.01,
      authenticity:         0.02,
    },
  },

  // ─── Momentum ───────────────────────────────────────────────
  momentum: {
    label: "Momentum",
    description: "Trend-following — prioritizes recent streaks, hot wallets, PnL trend",
    riskProfile: "high",
    weights: {
      // PnL factors (total: 0.30)
      pnl_7d:        0.12,  // recent PnL is critical
      pnl_30d:       0.05,
      pnl_all:       0.02,
      profit_factor: 0.05,
      sharpe_ratio:  0.03,
      roi:           0.03,
      // Risk factors (total: 0.10)
      max_drawdown:      0.03,
      avg_drawdown:      0.01,
      recovery_speed:    0.01,
      win_rate:          0.03,
      loss_aversion:     0.02,
      // Activity factors (total: 0.12)
      consistency:    0.05,
      longevity:      0.02,
      engagement:     0.03,
      position_depth: 0.02,
      // Liquidity factors (total: 0.08)
      fee_apr:          0.03,
      fee_tvl_ratio:    0.02,
      il_management:    0.01,
      range_efficiency: 0.01,
      volume_capture:   0.01,
      // Momentum factors (total: 0.25) ← HEAVILY boosted
      hot_streak:       0.10,
      pnl_trend:        0.08,
      volatility_adapt: 0.04,
      best_streak:      0.03,
      // Fingerprint factors (total: 0.15)
      archetype:            0.06,
      capital_efficiency:   0.03,
      behavior_consistency: 0.02,
      authenticity:         0.04,
    },
  },

  // ─── Hybrid (Smart Adaptive) ──────────────────────────────────
  hybrid: {
    label: "Hybrid (Adaptive)",
    description: "Smart adaptive — weights shift based on detected market regime and wallet performance",
    riskProfile: "adaptive",
    weights: {
      // Base weights (same as balanced)
      // These are dynamically adjusted at scoring time based on:
      // - Market volatility regime
      // - Wallet's demonstrated strengths
      // - Confidence in data quality
      pnl_7d:        0.08,
      pnl_30d:       0.08,
      pnl_all:       0.04,
      profit_factor: 0.06,
      sharpe_ratio:  0.04,
      roi:           0.04,
      max_drawdown:      0.08,
      avg_drawdown:      0.03,
      recovery_speed:    0.03,
      win_rate:          0.06,
      loss_aversion:     0.02,
      consistency:    0.05,
      longevity:      0.03,
      engagement:     0.02,
      position_depth: 0.02,
      fee_apr:          0.04,
      fee_tvl_ratio:    0.03,
      il_management:    0.03,
      range_efficiency: 0.02,
      volume_capture:   0.01,
      hot_streak:       0.03,
      pnl_trend:        0.03,
      volatility_adapt: 0.02,
      best_streak:      0.01,
      archetype:            0.04,
      capital_efficiency:   0.02,
      behavior_consistency: 0.01,
      authenticity:         0.03,
    },
  },
};

/**
 * Get weight profile for a given mode.
 * Falls back to balanced if mode not found.
 * @param {string} mode
 * @returns {WeightProfile}
 */
export function getWeightProfile(mode) {
  return WEIGHT_PROFILES[mode] || WEIGHT_PROFILES.balanced;
}

/**
 * Get all available strategy mode names.
 * @returns {string[]}
 */
export function getAvailableModes() {
  return Object.keys(WEIGHT_PROFILES);
}

/**
 * Get the risk profile for a mode.
 * @param {string} mode
 * @returns {string}
 */
export function getModeRisk(mode) {
  return WEIGHT_PROFILES[mode]?.riskProfile || "medium";
}

/**
 * Validate that weights sum to approximately 1.0 for all profiles.
 * @returns {Object<string, {total: number, balanced: boolean}>}
 */
export function validateAllWeights() {
  const results = {};
  for (const [mode, profile] of Object.entries(WEIGHT_PROFILES)) {
    const total = Object.values(profile.weights).reduce((a, b) => a + b, 0);
    results[mode] = {
      total: Math.round(total * 1000) / 1000,
      balanced: Math.abs(total - 1.0) < 0.02,
      riskProfile: profile.riskProfile,
    };
  }
  return results;
}
