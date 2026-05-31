/**
 * allocation/allocation-engine.js — Allocation orchestrator
 *
 * Combines size calculator + portfolio limits to produce final deployment decisions.
 * Called by executor.js before deploying a position.
 */

import { calculatePositionSize, calculateAvailableCapacity } from "./size-calculator.js";
import { checkPortfolioLimits, updatePortfolioState } from "./portfolio-limits.js";
import { config } from "../config.js";

/**
 * Run the full allocation engine for a proposed deploy.
 * @param {Object} params
 * @param {number} params.walletSolBalance
 * @param {number} params.poolVolatility
 * @param {number} params.poolScore
 * @param {number} params.openPositionCount
 * @param {number} params.maxPositions
 * @param {number} [params.totalSolDeployed=0]
 * @param {number} [params.dailyPnlUsd]
 * @param {number} [params.consecutiveOor=0]
 * @param {string} [params.riskProfile="moderate"]
 * @param {string} [params.sizingMode="compound"]
 * @returns {Object} decision
 */
export function runAllocation(params) {
  const {
    walletSolBalance = 0,
    poolVolatility = 2,
    poolScore = 50,
    openPositionCount = 0,
    maxPositions = 5,
    totalSolDeployed = 0,
    dailyPnlUsd,
    consecutiveOor = 0,
    riskProfile = "moderate",
    sizingMode = "compound",
  } = params;

  // Step 1: Check portfolio limits
  const portfolioCheck = checkPortfolioLimits({
    walletSolBalance,
    openPositionCount,
    maxPositions,
    totalSolDeployed,
    dailyPnlUsd,
    consecutiveOor,
    dailyLossLimit: config.management?.maxDailyLossUsd ?? -5,
    maxConsecutiveOor: config.management?.maxConsecutiveOorCloses ?? 3,
  }, { riskProfile });

  if (!portfolioCheck.allowed) {
    return {
      allowed: false,
      amountSol: 0,
      reason: portfolioCheck.reason,
      checks: portfolioCheck.checks,
    };
  }

  // Step 2: Calculate position size
  const sizeRec = calculatePositionSize({
    walletSolBalance,
    poolVolatility,
    poolScore,
    openPositionCount,
    maxPositions,
    riskProfile,
    sizingMode,
  });

  if (sizeRec.amountSol <= 0) {
    return {
      allowed: false,
      amountSol: 0,
      reason: "Position size computed to zero (likely volatility cap hit)",
      riskScore: sizeRec.riskScore,
      checks: portfolioCheck.checks,
      adjustments: sizeRec.adjustments,
    };
  }

  // Step 3: Re-check limits with new position size
  const finalCheck = checkPortfolioLimits({
    walletSolBalance,
    openPositionCount,
    maxPositions,
    totalSolDeployed,
    dailyPnlUsd,
    consecutiveOor,
    dailyLossLimit: config.management?.maxDailyLossUsd ?? -5,
    maxConsecutiveOor: config.management?.maxConsecutiveOorCloses ?? 3,
  }, { riskProfile, newPositionSizeSol: sizeRec.amountSol });

  if (!finalCheck.allowed) {
    return {
      allowed: false,
      amountSol: 0,
      reason: `After sizing: ${finalCheck.reason}`,
      checks: finalCheck.checks,
      adjustments: sizeRec.adjustments,
    };
  }

  // Step 4: Check if we need to downsize due to available capacity
  const capacity = calculateAvailableCapacity({
    walletSolBalance,
    openPositionCount,
    maxPositions,
    totalSolDeployed,
  });

  const finalAmount = Math.min(sizeRec.amountSol, capacity.availableSol);

  return {
    allowed: true,
    amountSol: finalAmount,
    maxAmountSol: sizeRec.maxAmountSol,
    riskScore: sizeRec.riskScore,
    sizingMode,
    riskProfile,
    poolVolatility,
    poolScore,
    reason: "Allocation checks passed",
    checks: finalCheck.checks,
    adjustments: sizeRec.adjustments,
    capacity,
  };
}

/**
 * Get a summary of current portfolio health.
 * @param {PortfolioState} portfolio
 * @returns {Object}
 */
export function getPortfolioHealth(portfolio) {
  const capacity = calculateAvailableCapacity(portfolio);
  const exposurePct = portfolio.walletSolBalance > 0
    ? ((portfolio.totalSolDeployed / portfolio.walletSolBalance) * 100).toFixed(1)
    : "0.0";

  return {
    openPositions: portfolio.openPositionCount,
    maxPositions: portfolio.maxPositions,
    totalDeployed: portfolio.totalSolDeployed,
    walletBalance: portfolio.walletSolBalance,
    exposurePct: `${exposurePct}%`,
    availableSol: capacity.availableSol,
    availableSlots: capacity.availableSlots,
    dailyPnlUsd: portfolio.dailyPnlUsd ?? 0,
    consecutiveOor: portfolio.consecutiveOor ?? 0,
    healthScore: computeHealthScore(portfolio),
  };
}

function computeHealthScore(portfolio) {
  let score = 100;
  if (portfolio.openPositionCount >= portfolio.maxPositions) score -= 20;
  if ((portfolio.consecutiveOor ?? 0) > 0) score -= (portfolio.consecutiveOor ?? 0) * 10;
  if ((portfolio.dailyPnlUsd ?? 0) < (portfolio.dailyLossLimit ?? -5)) score -= 30;
  const exposure = portfolio.totalSolDeployed / Math.max(1, portfolio.walletSolBalance);
  if (exposure > 0.5) score -= 15;
  return Math.max(0, score);
}
