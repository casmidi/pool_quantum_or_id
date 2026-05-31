/**
 * backtesting/types.js — Backtesting type definitions and constants
 */

/**
 * @typedef {Object} BacktestConfig
 * @property {number} initialBalanceSol — Starting SOL balance
 * @property {number} deployAmountSol — Fixed deploy size (if not dynamic)
 * @property {number} maxPositions
 * @property {number} maxDeployments — Total deploys allowed
 * @property {number} minBinStep
 * @property {number} maxBinStep
 * @property {number} outOfRangeWaitMinutes
 * @property {number} minScoreThreshold — Min pool score to deploy
 * @property {boolean} [useDynamicSizing=false]
 * @property {string[]} [poolAllowlist] — If set, only deploy to these pools
 * @property {string} [timeframe="5m"]
 */

/**
 * @typedef {Object} BacktestPosition
 * @property {string} poolAddress
 * @property {string} poolName
 * @property {number} amountSol
 * @property {number} binsBelow
 * @property {number} deployBin
 * @property {number} lowerBin
 * @property {number} upperBin
 * @property {number} deployTimestamp
 * @property {number} closeTimestamp
 * @property {number} feesEarnedSol
 * @property {number} impermanentLossSol
 * @property {number} netPnlSol
 * @property {number} closeReason — 1=OOR, 2=profit_target, 3=range_break, 4=manual
 */

/**
 * @typedef {Object} BacktestResult
 * @property {string} poolName
 * @property {number} totalDeployments
 * @property {number} totalCloses
 * @property {number} wins
 * @property {number} losses
 * @property {number} winRate — 0-100
 * @property {number} totalFeesSol
 * @property {number} totalPnlSol
 * @property {number} avgPnlPerDeploy
 * @property {number} avgDurationMinutes
 * @property {number} maxDrawdown
 * @property {number} sharpeRatio
 * @property {number} avgFeeTvlRatio
 * @property {Array<BacktestPosition>} positions
 */

export const TIMEFRAMES = {
  "1m": { minutes: 1, label: "1-minute" },
  "5m": { minutes: 5, label: "5-minute" },
  "15m": { minutes: 15, label: "15-minute" },
  "30m": { minutes: 30, label: "30-minute" },
  "1h": { minutes: 60, label: "1-hour" },
  "4h": { minutes: 240, label: "4-hour" },
  "1d": { minutes: 1440, label: "daily" },
};

export const CLOSE_REASONS = {
  OOR: 1,
  PROFIT_TARGET: 2,
  RANGE_BREAK: 3,
  MANUAL: 4,
};
