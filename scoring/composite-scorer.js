/**
 * scoring/composite-scorer.js
 * Master Composite Scorer — orchestrates all scoring factors into a
 * single 0–100 wallet performance score with full breakdown.
 *
 * Scoring pipeline:
 *   1. Run all 6 factor groups in parallel (pnl, risk, activity, liquidity, momentum, fingerprint)
 *   2. Apply weight profile from scoring/weight-profiles.js
 *   3. Compute weighted composite score
 *   4. Assign grade (S/A/B/C/D/F)
 *   5. Return full breakdown with explanations
 */

import { scorePnlFactors, FACTOR_META as PNL_META } from "./factors/pnl-factors.js";
import { scoreRiskFactors, FACTOR_META as RISK_META } from "./factors/risk-factors.js";
import { scoreActivityFactors, FACTOR_META as ACTIVITY_META } from "./factors/activity-factors.js";
import { scoreLiquidityFactors, FACTOR_META as LIQUIDITY_META } from "./factors/liquidity-factors.js";
import { scoreMomentumFactors, FACTOR_META as MOMENTUM_META } from "./factors/momentum-factors.js";
import { scoreFingerprintFactors, FACTOR_META as FINGERPRINT_META } from "./factors/fingerprint-factors.js";
import { getWeightProfile, getModeRisk } from "./weight-profiles.js";
import { log } from "../logger.js";

// ─── Factor Registry ───────────────────────────────────────────

const FACTOR_REGISTRY = {
  pnl: {
    scorer: scorePnlFactors,
    meta: PNL_META,
    weightGroup: 0.60, // max % of total weight for this group
  },
  risk: {
    scorer: scoreRiskFactors,
    meta: RISK_META,
    weightGroup: 0.40,
  },
  activity: {
    scorer: scoreActivityFactors,
    meta: ACTIVITY_META,
    weightGroup: 0.20,
  },
  liquidity: {
    scorer: scoreLiquidityFactors,
    meta: LIQUIDITY_META,
    weightGroup: 0.25,
  },
  momentum: {
    scorer: scoreMomentumFactors,
    meta: MOMENTUM_META,
    weightGroup: 0.30,
  },
  fingerprint: {
    scorer: scoreFingerprintFactors,
    meta: FINGERPRINT_META,
    weightGroup: 0.15,
  },
};

// ─── Grade Thresholds ──────────────────────────────────────────

const GRADE_THRESHOLDS = [
  { grade: "S", minScore: 85, label: "Elite" },
  { grade: "A", minScore: 70, label: "Strong" },
  { grade: "B", minScore: 55, label: "Good" },
  { grade: "C", minScore: 40, label: "Average" },
  { grade: "D", minScore: 25, label: "Weak" },
  { grade: "F", minScore: 0,  label: "Poor" },
];

function assignGrade(score) {
  for (const g of GRADE_THRESHOLDS) {
    if (score >= g.minScore) return g;
  }
  return GRADE_THRESHOLDS[GRADE_THRESHOLDS.length - 1];
}

// ─── Composite Scoring ─────────────────────────────────────────

/**
 * Score a single wallet using ALL factors.
 *
 * @param {object} metrics — WalletMetrics object
 * @param {string} [mode="balanced"] — Strategy mode name
 * @param {object} [thresholds={}] — Factor threshold overrides
 * @returns {object} WalletScore
 */
export function scoreWalletAdvanced(metrics, mode = "balanced", thresholds = {}) {
  const profile = getWeightProfile(mode);
  const weights = profile.weights;

  // ── 1. Run all factor groups ──
  const pnlResults         = scorePnlFactors(metrics, thresholds);
  const riskResults        = scoreRiskFactors(metrics, thresholds);
  const activityResults    = scoreActivityFactors(metrics, thresholds);
  const liquidityResults   = scoreLiquidityFactors(metrics, thresholds);
  const momentumResults    = scoreMomentumFactors(metrics, thresholds);
  const fingerprintResults = scoreFingerprintFactors(metrics, thresholds);

  const allFactors = {
    ...pnlResults,
    ...riskResults,
    ...activityResults,
    ...liquidityResults,
    ...momentumResults,
    ...fingerprintResults,
  };

  // ── 2. Apply weights and compute composite ──
  const contributions = {};
  let totalWeightedScore = 0;
  let totalWeightApplied = 0;

  for (const [factorName, factorResult] of Object.entries(allFactors)) {
    const weight = weights[factorName] ?? 0.01;
    const weighted = factorResult.score * weight;

    contributions[factorName] = {
      ...factorResult,
      weight,
      contribution: Math.round(weighted * 10) / 10,
    };

    totalWeightedScore += weighted;
    totalWeightApplied += weight;
  }

  // Normalize in case weights don't sum to exactly 1.0.
  // Factor scores are already 0-100, so the weighted average is also 0-100.
  const normalizedScore = totalWeightApplied > 0
    ? totalWeightedScore / totalWeightApplied
    : 0;

  const finalScore = Math.round(Math.max(0, Math.min(100, normalizedScore)));

  // ── 3. Assign grade ──
  const gradeInfo = assignGrade(finalScore);

  // ── 4. Factor group summary ──
  const groups = {
    pnl:         { factors: Object.keys(pnlResults),         score: avgGroupScore(pnlResults, weights) },
    risk:        { factors: Object.keys(riskResults),        score: avgGroupScore(riskResults, weights) },
    activity:    { factors: Object.keys(activityResults),    score: avgGroupScore(activityResults, weights) },
    liquidity:   { factors: Object.keys(liquidityResults),   score: avgGroupScore(liquidityResults, weights) },
    momentum:    { factors: Object.keys(momentumResults),    score: avgGroupScore(momentumResults, weights) },
    fingerprint: { factors: Object.keys(fingerprintResults), score: avgGroupScore(fingerprintResults, weights) },
  };

  return {
    score: finalScore,
    grade: gradeInfo.grade,
    gradeLabel: gradeInfo.label,
    mode,
    riskProfile: getModeRisk(mode),
    groups,
    factors: contributions,
    factorCount: Object.keys(contributions).length,
    timestamp: Date.now(),
  };
}

/**
 * Compute average score for a factor group, weighted by profile weights.
 */
function avgGroupScore(factors, weights) {
  let total = 0, count = 0;
  for (const [name, result] of Object.entries(factors)) {
    total += result.score;
    count++;
  }
  return count > 0 ? Math.round(total / count) : 0;
}

// ─── Batch Scoring ─────────────────────────────────────────────

/**
 * Score and rank multiple wallets.
 *
 * @param {Array<object>} wallets — Array of { address, label, ...metrics }
 * @param {string} [mode="balanced"]
 * @param {object} [thresholds={}]
 * @returns {Array<object>} Sorted array with rank, score, grade, breakdown
 */
export function rankWalletsAdvanced(wallets, mode = "balanced", thresholds = {}) {
  const scored = wallets.map((w) => {
    const result = scoreWalletAdvanced(w, mode, thresholds);
    return {
      address: w.address,
      label: w.label || w.name || w.address?.slice(0, 8),
      ...result,
      rawMetrics: w,
    };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Assign ranks
  scored.forEach((s, i) => {
    s.rank = i + 1;
  });

  return scored;
}

// ─── Wallet Score Short (quick single-wallet) ─────────────────

/**
 * Quick score a single wallet. Used by scoreWalletShort in top-performers.js.
 * @param {string} address
 * @param {object} metrics
 * @param {string} [mode]
 * @returns {object}
 */
export function scoreSingleWallet(address, metrics, mode = "balanced") {
  const result = scoreWalletAdvanced(metrics, mode);
  return {
    address,
    label: metrics.label || address?.slice(0, 8),
    ...result,
    rawMetrics: metrics,
  };
}

export { FACTOR_REGISTRY, GRADE_THRESHOLDS, assignGrade };
