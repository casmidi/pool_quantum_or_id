/**
 * scoring/types.js
 * Type definitions (JSDoc) for the Multi-Layer Scoring Engine.
 * 
 * These are NOT runtime exports — they serve as documentation and
 * IDE autocompletion hints. All "types" below are plain objects
 * with the described shapes.
 */

/**
 * @typedef {object} WalletMetrics
 * Raw wallet performance metrics (input to scoring engine).
 * @property {string}      address          — Solana wallet address
 * @property {string}      [label]          — Human-readable label
 * @property {number|null} pnl7d            — PnL last 7 days (SOL or USD)
 * @property {number|null} pnl30d           — PnL last 30 days
 * @property {number|null} pnlAll           — PnL all-time
 * @property {number|null} roi7dPct         — ROI last 7 days (%)
 * @property {number|null} roi30dPct        — ROI last 30 days (%)
 * @property {number|null} winRate          — Win rate (0-100)
 * @property {number|null} totalTrades      — Total closed trades
 * @property {number|null} wins             — Winning trades
 * @property {number|null} losses           — Losing trades
 * @property {number|null} profitFactor     — Gross profit / gross loss
 * @property {number|null} feesEarned       — Total fees earned (SOL/USD)
 * @property {number|null} feeApr           — Fee APR (%)
 * @property {number|null} lpVolumeSol      — Total LP volume (SOL)
 * @property {number|null} maxDrawdownPct   — Max drawdown (%)
 * @property {number|null} avgDrawdownPct   — Average drawdown (%)
 * @property {number|null} recoveryFactor   — Recovery speed factor
 * @property {number|null} sharpeRatio      — Risk-adjusted return ratio
 * @property {number|null} sortinoRatio     — Downside risk-adjusted ratio
 * @property {number|null} daysActive30d    — Days with activity (0-30)
 * @property {number|null} totalDaysActive  — Total days since first activity
 * @property {number|null} streakCurrent    — Current winning/losing streak
 * @property {number|null} streakBest       — Best winning streak
 * @property {number|null} streakWorst      — Worst losing streak
 * @property {number|null} binUtilization   — Average bin utilization (0-100%)
 * @property {number|null} rangeEfficiency  — Range efficiency score (0-100)
 * @property {number|null} avgPositionAge   — Average position hold duration (hours)
 * @property {number|null} avgPositionSize  — Average position size (SOL)
 * @property {number|null} topHoldersPct    — Top 10 holder concentration
 * @property {number|null} snipingRatio     — % of trades that are snipes
 * @property {number|null} depositCount     — Number of deposits
 * @property {number|null} withdrawalCount  — Number of withdrawals
 * @property {number|null} swapCount        — Number of swaps
 * @property {number|null} walletAge        — Wallet age in days
 * @property {number|null} firstActivity    — Timestamp of first activity
 * @property {number|null} lastActivity     — Timestamp of last activity
 * @property {string}      [source]         — Data source identifier
 */

/**
 * @typedef {object} FactorResult
 * Result of a single scoring factor.
 * @property {string}  name        — Factor name (e.g. "pnl_7d")
 * @property {number}  score       — Normalized score (0-100)
 * @property {number}  raw         — Raw input value
 * @property {number}  weight      — Applied weight
 * @property {number}  contribution — Weighted contribution to total
 * @property {string}  [reason]    — Human-readable explanation
 * @property {'good'|'neutral'|'bad'} [sentiment]
 */

/**
 * @typedef {object} WalletScore
 * Complete scoring result for a single wallet.
 * @property {string}         address
 * @property {string}         [label]
 * @property {number}         totalScore     — Weighted composite (0-100)
 * @property {string}         grade          — S/A/B/C/D/F
 * @property {object}         factors        — { factorName: FactorResult }
 * @property {WalletMetrics}  [rawMetrics]   — Original input metrics
 * @property {string}         mode           — Strategy mode used
 * @property {number}         [rank]         — Ranking position (set externally)
 */

/**
 * @typedef {object} WeightProfile
 * Weight configuration for a strategy mode.
 * @property {string}  mode        — Mode name
 * @property {string}  description — Human-readable description
 * @property {object}  weights     — { factorName: number (0-1) }
 */

export default {};
