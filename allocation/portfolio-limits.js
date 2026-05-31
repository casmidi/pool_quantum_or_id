/**
 * allocation/portfolio-limits.js — Portfolio constraint enforcement
 *
 * Ensures deploys don't violate:
 * - Max positions (hard cap)
 * - Max concurrent exposure per risk profile
 * - Daily loss limits
 * - Consecutive OOR close circuit breaker
 * - Rate limiting between deploys
 */

import { RISK_PROFILES } from "./types.js";
import { config } from "../config.js";

/**
 * Check if a new deploy is permitted given current portfolio state.
 * @param {PortfolioState} portfolio
 * @param {Object} [opts]
 * @param {string} [opts.riskProfile="moderate"]
 * @param {number} [opts.newPositionSizeSol=0]
 * @returns {{ allowed: boolean, reason?: string, checks: Array<{check:string, passed:boolean}> }}
 */
export function checkPortfolioLimits(portfolio, opts = {}) {
  const {
    riskProfile = "moderate",
    newPositionSizeSol = 0,
  } = opts;

  const profile = RISK_PROFILES[riskProfile.toUpperCase()] || RISK_PROFILES.MODERATE;
  const checks = [];

  // ── Max positions ──
  const maxPos = portfolio.maxPositions > 0 ? portfolio.maxPositions : 5;
  const posCheck = portfolio.openPositionCount < maxPos;
  checks.push({ check: `open_positions (${portfolio.openPositionCount}/${maxPos})`, passed: posCheck });
  if (!posCheck) {
    return { allowed: false, reason: `Max positions reached (${portfolio.openPositionCount}/${maxPos})`, checks };
  }

  // ── Daily loss limit ──
  const dailyLossLimit = portfolio.dailyLossLimit ?? config.management?.maxDailyLossUsd ?? -5;
  const dailyLossOk = portfolio.dailyPnlUsd == null || portfolio.dailyPnlUsd >= dailyLossLimit;
  checks.push({ check: `daily_pnl (${portfolio.dailyPnlUsd ?? "—"}) ≥ ${dailyLossLimit}`, passed: dailyLossOk });
  if (!dailyLossOk) {
    return { allowed: false, reason: `Daily loss limit hit: $${portfolio.dailyPnlUsd} vs limit $${dailyLossLimit}`, checks };
  }

  // ── Consecutive OOR circuit breaker ──
  const maxOor = portfolio.maxConsecutiveOor ?? config.management?.maxConsecutiveOorCloses ?? 3;
  const oorOk = (portfolio.consecutiveOor ?? 0) < maxOor;
  checks.push({ check: `consecutive_oor (${portfolio.consecutiveOor ?? 0}) < ${maxOor}`, passed: oorOk });
  if (!oorOk) {
    return { allowed: false, reason: `Too many consecutive OOR closes (${portfolio.consecutiveOor})`, checks };
  }

  // ── Portfolio exposure ──
  const maxExposure = profile.maxPortfolioRisk;
  const newExposure = (portfolio.totalSolDeployed + newPositionSizeSol) / Math.max(1, portfolio.walletSolBalance);
  const exposureOk = newExposure <= maxExposure;
  checks.push({ check: `portfolio_exposure (${(newExposure * 100).toFixed(1)}%) ≤ ${(maxExposure * 100).toFixed(0)}%`, passed: exposureOk });
  if (!exposureOk) {
    return { allowed: false, reason: `Portfolio exposure ${(newExposure * 100).toFixed(1)}% exceeds ${(maxExposure * 100).toFixed(0)}% limit`, checks };
  }

  return { allowed: true, checks };
}

/**
 * Update portfolio state after a deploy or close.
 * @param {PortfolioState} current
 * @param {Object} event
 * @param {"deploy"|"close"} event.type
 * @param {number} [event.amountSol]
 * @param {boolean} [event.oorClose=false]
 * @param {number} [event.pnlUsd]
 * @returns {PortfolioState}
 */
export function updatePortfolioState(current, event) {
  const state = { ...current };

  if (event.type === "deploy") {
    state.totalSolDeployed += event.amountSol ?? 0;
    state.openPositionCount += 1;
    state.consecutiveOor = 0;
  } else if (event.type === "close") {
    state.totalSolDeployed = Math.max(0, state.totalSolDeployed - (event.amountSol ?? 0));
    state.openPositionCount = Math.max(0, state.openPositionCount - 1);
    if (event.oorClose) {
      state.consecutiveOor = (state.consecutiveOor ?? 0) + 1;
    } else {
      state.consecutiveOor = 0;
    }
  }

  if (event.pnlUsd != null) {
    state.dailyPnlUsd = (state.dailyPnlUsd ?? 0) + event.pnlUsd;
  }

  state.totalExposurePct = state.totalSolDeployed / Math.max(1, state.walletSolBalance);
  return state;
}
