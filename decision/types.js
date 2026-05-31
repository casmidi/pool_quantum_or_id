/**
 * Decision Layer — Type Definitions
 * Meridian Intelligent Decision Layer
 */

/**
 * @typedef {Object} DecisionConfig
 * @property {number} minScoreToCopy - Minimum wallet score to consider copying (default 45)
 * @property {number} minConfidence - Minimum confidence score to act (0-1, default 0.6)
 * @property {number} maxCorrelation - Max allowed correlation between selected wallets (0-1, default 0.7)
 * @property {number} decayLookbackDays - Days to look back for decay detection (default 14)
 * @property {number} decayThresholdPct - Score drop % to flag decay (default 20)
 * @property {number} minRangeQuality - Minimum range quality score to copy position (0-100, default 50)
 * @property {number} maxVolatilityForCopy - Max pool volatility for copy (default 8)
 * @property {number} minFeeTvlForCopy - Min fee/TVL ratio for copy (default 0.02)
 * @property {boolean} requireSmartWalletConfirm - Require smart wallet confirmation (default true)
 * @property {number} cooldownDays - Days before re-evaluating rejected wallet (default 7)
 */

/**
 * @typedef {Object} DecisionResult
 * @property {string} walletAddress - Wallet address evaluated
 * @property {string} action - "COPY" | "HOLD" | "SKIP" | "BLACKLIST"
 * @property {number} confidence - Confidence score 0-1
 * @property {string[]} reasons - List of reasons for decision
 * @property {Object} [analysis] - Detailed analysis breakdown
 * @property {Object} [risks] - Risk factors identified
 */

/**
 * @typedef {Object} PositionAnalysis
 * @property {string} poolAddress - Pool address
 * @property {string} poolName - Pool name
 * @property {number} lowerBin - Lower bin of range
 * @property {number} upperBin - Upper bin of range
 * @property {number} activeBin - Current active bin
 * @property {number} rangeQuality - Quality score of the range (0-100)
 * @property {number} feeTvlRatio - Fee/TVL ratio
 * @property {number} volatility - Pool volatility
 * @property {boolean} inRange - Whether position is in range
 * @property {number} ageHours - Position age in hours
 * @property {number} pnlPct - PnL percentage
 * @property {number} feesEarnedSol - Fees earned in SOL
 */

/**
 * @typedef {Object} CorrelationMatrix
 * @property {string[][]} walletPairs - Pairs of correlated wallets
 * @property {number[][]} correlations - Correlation values
 * @property {number} avgCorrelation - Average correlation across all pairs
 * @property {string[]} [recommendedRemovals] - Wallets recommended for removal
 */

/**
 * @typedef {Object} DecaySignal
 * @property {string} walletAddress - Wallet with detected decay
 * @property {number} currentScore - Current score
 * @property {number} previousScore - Previous score (lookback period)
 * @property {number} dropPct - Percentage drop
 * @property {boolean} critical - Whether this is critical (> 40% drop)
 * @property {string} trend - "declining" | "stable" | "recovering" | "critical"
 */

export const DEFAULT_DECISION_CONFIG = {
  minScoreToCopy: 45,
  minConfidence: 0.6,
  maxCorrelation: 0.7,
  decayLookbackDays: 14,
  decayThresholdPct: 20,
  minRangeQuality: 50,
  maxVolatilityForCopy: 8,
  minFeeTvlForCopy: 0.02,
  requireSmartWalletConfirm: true,
  cooldownDays: 7,
};

export const ACTION_LABELS = {
  COPY: "✅ Copy this wallet",
  HOLD: "⏳ Monitor — not enough data",
  SKIP: "⏭️ Skip — insufficient confidence",
  BLACKLIST: "🚫 Blacklist — high risk detected",
};
