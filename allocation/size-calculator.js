/**
 * allocation/size-calculator.js — Dynamic position sizing engine
 *
 * Computes optimal deploy amount based on:
 * - Wallet balance (compounding)
 * - Pool volatility (scale down as vol rises)
 * - Pool score (scale up for high-conviction)
 * - Portfolio constraints (max positions, max exposure)
 */

import { SIZING_MODES, RISK_PROFILES } from "./types.js";
import { config } from "../config.js";

/**
 * Calculate optimal SOL deploy amount.
 * @param {Object} params
 * @param {number} params.walletSolBalance
 * @param {number} params.poolVolatility — 0-10+ scale
 * @param {number} params.poolScore — 0-100 composite score
 * @param {number} params.openPositionCount
 * @param {number} params.maxPositions
 * @param {string} [params.riskProfile="moderate"]
 * @param {string} [params.sizingMode="compound"]
 * @returns {{ amountSol: number, maxAmountSol: number, riskScore: number, sizingMode: string, adjustments: Array<{factor:string,impact:number}> }}
 */
export function calculatePositionSize(params) {
  const {
    walletSolBalance = 0,
    poolVolatility = 2,
    poolScore = 50,
    openPositionCount = 0,
    maxPositions = 5,
    riskProfile = "moderate",
    sizingMode = "compound",
  } = params;

  const profile = RISK_PROFILES[riskProfile.toUpperCase()] || RISK_PROFILES.MODERATE;
  const adjustments = [];

  // ── Base amount: percentage of wallet ──
  let baseAmount = walletSolBalance * profile.maxPositionPct;
  adjustments.push({ factor: "wallet_base", impact: baseAmount });

  // ── Score scaling (if score_scaled mode) ──
  let scoreMultiplier = 1.0;
  if (sizingMode === SIZING_MODES.SCORE_SCALED) {
    scoreMultiplier = 0.5 + (poolScore / 100) * 0.5; // 0.5x at 0, 1.0x at 100
    adjustments.push({ factor: "score_scaling", impact: scoreMultiplier });
  }

  // ── Volatility scaling ──
  let volMultiplier = 1.0;
  if (sizingMode === SIZING_MODES.VOLATILITY_SCALED || sizingMode === SIZING_MODES.SCORE_SCALED) {
    // Scale down linearly: 1.0x at vol=0, 0.6x at vol=5, 0.4x at vol=10
    volMultiplier = Math.max(0.4, 1.0 - poolVolatility * 0.06);
    adjustments.push({ factor: "volatility_scaling", impact: volMultiplier });
  }

  // ── Volatility cap check ──
  if (poolVolatility > profile.volatilityCap) {
    adjustments.push({ factor: "volatility_cap", impact: 0 });
    return {
      amountSol: 0,
      maxAmountSol: 0,
      riskScore: 0,
      sizingMode,
      adjustments,
    };
  }

  // ── Position count scaling ──
  const positionRatio = openPositionCount / Math.max(1, maxPositions);
  const countMultiplier = 1.0 - positionRatio * 0.3; // reduce by up to 30% as we fill up
  adjustments.push({ factor: "position_count", impact: countMultiplier });

  // ── Floor and ceiling ──
  const defaultDeployAmount = Number(
    config.management?.deployAmountSol ?? config.risk?.deployAmountSol ?? 0.3,
  );
  const maxDeployAmount = Number(
    config.risk?.maxDeployAmount ?? config.management?.maxDeployAmount ?? 10,
  );
  const floorAmount = Math.min(defaultDeployAmount, walletSolBalance * 0.05);
  const ceilingAmount = Math.min(maxDeployAmount, walletSolBalance * profile.maxPositionPct);

  let finalAmount = baseAmount * scoreMultiplier * volMultiplier * countMultiplier;
  finalAmount = Math.max(floorAmount, Math.min(ceilingAmount, finalAmount));

  // ── Risk score (0-100) ──
  const riskScore = computeRiskScore(poolVolatility, poolScore, positionRatio);

  adjustments.push({ factor: "final_clamp", impact: finalAmount });

  return {
    amountSol: roundSol(finalAmount),
    maxAmountSol: roundSol(ceilingAmount),
    riskScore,
    sizingMode,
    adjustments,
  };
}

/**
 * Calculate total SOL that can still be deployed.
 * @param {PortfolioState} portfolio
 * @returns {{availableSol: number, availableSlots: number, maxNewPositionSol: number}}
 */
export function calculateAvailableCapacity(portfolio) {
  const {
    walletSolBalance = 0,
    openPositionCount = 0,
    maxPositions = 5,
    totalSolDeployed = 0,
  } = portfolio;

  const gasReserve = Number(config.management?.gasReserve ?? 0.2);
  const deployable = Math.max(0, walletSolBalance - gasReserve - totalSolDeployed);
  const availableSlots = Math.max(0, maxPositions - openPositionCount);

  return {
    availableSol: roundSol(deployable),
    availableSlots,
    maxNewPositionSol: availableSlots > 0
      ? roundSol(deployable / availableSlots)
      : 0,
  };
}

// ── Helpers ──

function computeRiskScore(volatility, score, positionRatio) {
  // Higher vol = higher risk
  const volRisk = Math.min(50, volatility * 10);
  // Lower score = higher risk
  const scoreRisk = Math.max(0, 50 - score * 0.5);
  // More positions = higher diversification (lower risk per new position)
  const diversificationBonus = positionRatio * 10;

  return Math.min(100, Math.max(0, volRisk + scoreRisk - diversificationBonus));
}

function roundSol(amount) {
  return Math.round(amount * 1e9) / 1e9;
}
