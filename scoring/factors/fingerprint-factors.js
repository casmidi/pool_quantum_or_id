/**
 * scoring/factors/fingerprint-factors.js
 * Wallet Fingerprinting — identifies wallet behavioral archetype.
 *
 * Classifies wallets into categories:
 *   - professional_lp:  True LP specialist — balanced deposits/withdrawals
 *   - sniper:           Quick in/out trades, low commitment
 *   - farmer:           Yield farmer — enters for incentives, leaves quickly
 *   - whale:            Large capital, fewer but bigger positions
 *   - retail:           Small capital, diverse positions
 *   - smart_money:      KOL/insider — good timing, above-average returns
 *   - unknown:          Insufficient data to classify
 *
 * Factors:
 *   - archetype_score:  How well wallet fits its detected archetype
 *   - capital_efficiency: Capital utilization ratio
 *   - behavior_consistency: Does behavior match across time?
 *   - authenticity:     Likelihood of being a genuine LP (vs bot/sybil)
 */

import { normLinear, normBell, normInverse, normLog } from "../normalizers.js";

const DEFAULT_THRESHOLDS = {
  minDepositsForLP:     10,
  minWithdrawalsForLP:  5,
  sniperMaxAgeHours:    72,
  farmerMinSwaps:       20,
  whaleMinCapital:      1000,  // SOL or USD
  smartMoneyMinReturn:   1.5,  // profit factor floor
};

/**
 * Detect wallet archetype from available metrics.
 * @returns {{ archetype: string, confidence: number }}
 */
function detectArchetype(metrics) {
  const deposits = metrics.depositCount ?? 0;
  const withdrawals = metrics.withdrawalCount ?? 0;
  const swaps = metrics.swapCount ?? 0;
  const walletAge = metrics.walletAge ?? metrics.totalDaysActive ?? 0;
  const pnl30d = metrics.pnl30d ?? 0;
  const profitFactor = metrics.profitFactor ?? 1;
  const feesEarned = metrics.feesEarned ?? 0;
  const lpVolume = metrics.lpVolumeSol ?? 0;
  const avgPositionSize = metrics.avgPositionSize ?? 0;

  let archetype = "unknown";
  let confidence = 10;

  // Professional LP: balanced deposits/withdrawals, significant fees
  if (deposits >= 10 && withdrawals >= 5 && feesEarned > 5 && walletAge >= 14) {
    archetype = "professional_lp";
    confidence = 70 + Math.min(30, Math.round(feesEarned / 10));
  }
  // Smart money: high returns, good timing
  else if (profitFactor >= 1.5 && pnl30d > 10 && walletAge >= 7) {
    archetype = "smart_money";
    confidence = 60 + Math.min(40, Math.round(profitFactor * 10));
  }
  // Whale: large capital, fewer positions
  else if ((avgPositionSize >= 10 || lpVolume >= 1000) && deposits < 20) {
    archetype = "whale";
    confidence = 50 + Math.min(50, Math.round(Math.min(1, lpVolume / 10000) * 50));
  }
  // Farmer: many swaps, low fees, short-lived positions
  else if (swaps >= 20 && feesEarned < 1 && walletAge < 30) {
    archetype = "farmer";
    confidence = 60 + Math.min(40, Math.round(swaps / 2));
  }
  // Sniper: very new wallet, many deposits but few withdrawals
  else if (walletAge < 7 && deposits > 5 && withdrawals < 3) {
    archetype = "sniper";
    confidence = 50 + Math.min(50, Math.round(deposits * 5));
  }
  // Retail: everything else with some activity
  else if (deposits > 0 || swaps > 0) {
    archetype = "retail";
    confidence = 40 + Math.min(60, Math.round((deposits + swaps) / 2));
  }

  return { archetype, confidence };
}

/**
 * Score archetype fit — how well the wallet matches its detected archetype.
 * Professional LP and smart money = highest scores.
 */
function scoreArchetype(metrics, thresholds) {
  const { archetype, confidence } = detectArchetype(metrics);

  // Archetype score mapping (0-100)
  const archetypeScores = {
    professional_lp: 90,
    smart_money:     85,
    whale:           70,
    retail:          50,
    farmer:          30,
    sniper:          15,
    unknown:         30,
  };

  const baseScore = archetypeScores[archetype] ?? 30;
  // Adjust for confidence
  const score = Math.round(baseScore * (confidence / 100));

  return {
    name: "archetype",
    score,
    raw: archetype,
    reason: `${archetype.replace(/_/g, " ")} wallet (${confidence}% confidence)`,
    sentiment: archetype === "professional_lp" || archetype === "smart_money" ? "good"
      : archetype === "whale" || archetype === "retail" ? "neutral"
      : "bad",
  };
}

/**
 * Score capital efficiency — how effectively capital is deployed.
 * High deployment ratio + high fees/capital = efficient.
 */
function scoreCapitalEfficiency(metrics, thresholds) {
  const feesEarned = metrics.feesEarned ?? 0;
  const lpVolume = metrics.lpVolumeSol ?? 0;
  const deposits = metrics.depositCount ?? 1;
  const withdrawals = metrics.withdrawalCount ?? 0;

  // Capital efficiency = fees / (deposits - withdrawals) * avg position
  // Rough estimate: how much fee is generated per unit of capital
  const netDeposits = Math.max(1, deposits - Math.min(deposits - 1, withdrawals));
  const efficiencyPerDeposit = feesEarned / netDeposits;

  const score = normLog(efficiencyPerDeposit, 0, 10, 3);
  return {
    name: "capital_efficiency",
    score,
    raw: parseFloat(efficiencyPerDeposit.toFixed(4)),
    reason: efficiencyPerDeposit >= 5
      ? `${efficiencyPerDeposit.toFixed(2)} SOL/deposit (highly efficient)`
      : efficiencyPerDeposit >= 1
      ? `${efficiencyPerDeposit.toFixed(2)} SOL/deposit (moderate)`
      : `${efficiencyPerDeposit.toFixed(2)} SOL/deposit (low efficiency)`,
    sentiment: efficiencyPerDeposit >= 2 ? "good" : efficiencyPerDeposit >= 0.5 ? "neutral" : "bad",
  };
}

/**
 * Score behavior consistency — whether wallet behavior is consistent over time.
 * Consistent behavior = more predictable.
 */
function scoreBehaviorConsistency(metrics, thresholds) {
  const daysActive = metrics.daysActive30d ?? 0;
  const totalTx = (metrics.depositCount ?? 0) + (metrics.withdrawalCount ?? 0) + (metrics.swapCount ?? 0);

  if (daysActive === 0 || totalTx === 0) {
    return { name: "behavior_consistency", score: 50, raw: 0, reason: "insufficient data", sentiment: "neutral" };
  }

  // Consistency = tx per active day. Higher = more consistent.
  const txPerDay = totalTx / daysActive;
  // Ideal: 1-10 tx/day consistently
  const score = normBell(txPerDay, 4, 4, 100);
  return {
    name: "behavior_consistency",
    score,
    raw: parseFloat(txPerDay.toFixed(2)),
    reason: txPerDay >= 2 && txPerDay <= 8
      ? `${txPerDay.toFixed(1)} tx/day (consistent)`
      : txPerDay > 8
      ? `${txPerDay.toFixed(1)} tx/day (high frequency)`
      : `${txPerDay.toFixed(1)} tx/day (sporadic)`,
    sentiment: txPerDay >= 1 && txPerDay <= 10 ? "good" : "neutral",
  };
}

/**
 * Score authenticity — how likely this is a genuine LP wallet vs bot/sybil.
 * Penalizes: very new wallets, extreme activity patterns, lack of diversity.
 */
function scoreAuthenticity(metrics, thresholds) {
  let deductions = 0;
  const reasons = [];

  // Very new wallet
  const walletAge = metrics.walletAge ?? metrics.totalDaysActive ?? 0;
  if (walletAge < 1) { deductions += 40; reasons.push("less than 1 day old"); }
  else if (walletAge < 3) { deductions += 20; reasons.push("less than 3 days old"); }
  else if (walletAge < 7) { deductions += 10; reasons.push("less than 1 week old"); }

  // No LP activity at all
  const deposits = metrics.depositCount ?? 0;
  const withdrawals = metrics.withdrawalCount ?? 0;
  if (deposits === 0 && withdrawals === 0 && (metrics.swapCount ?? 0) === 0) {
    deductions += 30;
    reasons.push("no LP activity detected");
  }

  // Suspiciously perfect record
  const winRate = metrics.winRate ?? 50;
  if (winRate >= 98 && (metrics.totalTrades ?? 0) > 10) {
    deductions += 25;
    reasons.push("suspiciously high win rate");
  }

  // Extreme volume with low fees (wash trading pattern)
  const feesEarned = metrics.feesEarned ?? 0;
  const lpVolume = metrics.lpVolumeSol ?? 0;
  if (lpVolume > 1000 && feesEarned < 1) {
    deductions += 20;
    reasons.push("high volume / low fee ratio");
  }

  const baseScore = 100;
  const score = Math.max(0, Math.min(100, baseScore - deductions));
  return {
    name: "authenticity",
    score,
    raw: { deductions, flags: reasons.length },
    reason: score >= 80 ? "Likely genuine LP wallet"
      : score >= 50 ? `${deductions}pts deducted (${reasons.join("; ")})`
      : `Suspicious pattern detected: ${reasons.join("; ")}`,
    sentiment: score >= 70 ? "good" : score >= 40 ? "neutral" : "bad",
  };
}

/**
 * Run all Fingerprint factors for a wallet.
 */
export function scoreFingerprintFactors(metrics, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    archetype:             scoreArchetype(metrics, t),
    capital_efficiency:    scoreCapitalEfficiency(metrics, t),
    behavior_consistency:  scoreBehaviorConsistency(metrics, t),
    authenticity:          scoreAuthenticity(metrics, t),
  };
}

export const FACTOR_META = {
  archetype:            { group: "fingerprint", description: "Wallet behavioral archetype classification", defaultWeight: 0.08 },
  capital_efficiency:   { group: "fingerprint", description: "Capital utilization efficiency", defaultWeight: 0.05 },
  behavior_consistency: { group: "fingerprint", description: "Behavior pattern consistency", defaultWeight: 0.04 },
  authenticity:         { group: "fingerprint", description: "Genuine wallet vs bot/sybil likelihood", defaultWeight: 0.06 },
};
