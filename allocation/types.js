/**
 * allocation/types.js — Allocation system type definitions and constants
 */

// ─── Position Sizing Modes ───────────────────────────────────────

export const SIZING_MODES = {
  FIXED: "fixed",
  COMPOUND: "compound",
  VOLATILITY_SCALED: "volatility_scaled",
  SCORE_SCALED: "score_scaled",
};

// ─── Risk Profiles ───────────────────────────────────────────────

export const RISK_PROFILES = {
  CONSERVATIVE: {
    name: "conservative",
    maxPositionPct: 0.15,
    maxPortfolioRisk: 0.10,
    minScoreThreshold: 72,
    volatilityCap: 4.0,
  },
  MODERATE: {
    name: "moderate",
    maxPositionPct: 0.25,
    maxPortfolioRisk: 0.20,
    minScoreThreshold: 55,
    volatilityCap: 6.0,
  },
  AGGRESSIVE: {
    name: "aggressive",
    maxPositionPct: 0.35,
    maxPortfolioRisk: 0.35,
    minScoreThreshold: 40,
    volatilityCap: 10.0,
  },
};

// ─── Allocation Decision Types ───────────────────────────────────

/**
 * @typedef {Object} AllocationDecision
 * @property {string} poolAddress
 * @property {string} poolName
 * @property {number} amountSol — SOL amount to deploy
 * @property {number} binsBelow — bins below active
 * @property {number} binsAbove — bins above active
 * @property {string} sizingMode — from SIZING_MODES
 * @property {number} volatility — pool volatility
 * @property {number} poolScore — composite pool score
 * @property {number} riskAdjustedScore — score after risk adjustment
 * @property {string} riskProfile — from RISK_PROFILES
 * @property {string} reason — rationale
 */

/**
 * @typedef {Object} PortfolioState
 * @property {number} totalSolDeployed
 * @property {number} walletSolBalance
 * @property {number} openPositionCount
 * @property {number} maxPositions
 * @property {number} totalExposurePct — % of wallet deployed
 * @property {number} avgPositionScore — avg composite score
 * @property {number} dailyPnlUsd — running daily P&L
 * @property {number} consecutiveOor — consecutive OOR closes
 * @property {number} dailyLossLimit — max daily loss in USD
 */

/**
 * @typedef {Object} SizeRecommendation
 * @property {number} amountSol
 * @property {number} maxAmountSol
 * @property {number} riskScore
 * @property {string} sizingMode
 * @property {Array<{factor:string, impact:number}>} adjustments
 */
