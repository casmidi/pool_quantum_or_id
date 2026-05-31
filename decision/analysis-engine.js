/**
 * Decision Analysis Engine
 * Evaluates whether a master wallet's position is worth copying.
 */
import { log } from "../logger.js";
import { DEFAULT_DECISION_CONFIG } from "./types.js";

/**
 * Analyze a position from a top wallet and determine if it's copy-worthy.
 * @param {Object} position - Position data from the wallet
 * @param {Object} walletMetrics - Overall wallet metrics (score, grade, etc.)
 * @param {Object} [config] - Decision config overrides
 * @returns {Promise<{action: string, confidence: number, reasons: string[], risks: string[]}>}
 */
export async function analyzePositionForCopy(position, walletMetrics, config = {}) {
  const cfg = { ...DEFAULT_DECISION_CONFIG, ...config };
  const reasons = [];
  const risks = [];

  if (!position) {
    return { action: "SKIP", confidence: 0, reasons: ["No position data available"], risks: ["missing_data"] };
  }

  // 1. Wallet score check
  const walletScore = walletMetrics?.score ?? walletMetrics?._score ?? 0;
  if (walletScore < cfg.minScoreToCopy) {
    reasons.push(`Wallet score ${walletScore} below minimum ${cfg.minScoreToCopy}`);
    return { action: "SKIP", confidence: 0.1, reasons, risks: ["low_wallet_score"] };
  }
  reasons.push(`Wallet score ${walletScore} ≥ ${cfg.minScoreToCopy}`);

  // 2. Range quality analysis
  const rangeQuality = assessRangeQuality(position);
  if (rangeQuality < cfg.minRangeQuality) {
    risks.push(`Range quality ${rangeQuality}% below minimum ${cfg.minRangeQuality}%`);
    reasons.push(`Range quality ${rangeQuality}% — below threshold`);
    return { action: "HOLD", confidence: 0.3, reasons, risks: ["poor_range_quality"] };
  }
  reasons.push(`Range quality ${rangeQuality}% ✓`);

  // 3. Fee/TVL ratio check
  const feeTvl = position.feeTvlRatio ?? position.fee_active_tvl_ratio ?? position.fee_tvl_ratio ?? 0;
  if (feeTvl < cfg.minFeeTvlForCopy) {
    risks.push(`Fee/TVL ${feeTvl} below minimum ${cfg.minFeeTvlForCopy}`);
    reasons.push(`Fee/TVL ${feeTvl} — low yield`);
    return { action: "HOLD", confidence: 0.35, reasons, risks: ["low_fee_tvl"] };
  }
  reasons.push(`Fee/TVL ${feeTvl} ✓`);

  // 4. Volatility check
  const volatility = position.volatility ?? 0;
  if (volatility > cfg.maxVolatilityForCopy) {
    risks.push(`Volatility ${volatility} exceeds max ${cfg.maxVolatilityForCopy}`);
    reasons.push(`Volatility ${volatility} — high IL risk`);
    return { action: "HOLD", confidence: 0.4, reasons, risks: ["high_volatility"] };
  }
  reasons.push(`Volatility ${volatility} ✓`);

  // 5. In-range check
  if (position.inRange === false || position.in_range === false) {
    const oorMinutes = position.minutesOutOfRange ?? position.minutes_out_of_range ?? 0;
    risks.push(`Position is out of range (${oorMinutes}m)`);
    reasons.push(`OOR ${oorMinutes}m — waiting for re-entry`);
    return { action: "HOLD", confidence: 0.45, reasons, risks: ["out_of_range"] };
  }
  reasons.push("In range ✓");

  // 6. Position age & PnL
  const ageHours = position.ageHours ?? (position.age_minutes != null ? position.age_minutes / 60 : null);
  const pnlPct = position.pnlPct ?? position.pnl_pct ?? 0;
  if (ageHours != null && ageHours < 1 && pnlPct > 10) {
    reasons.push(`New position (${ageHours.toFixed(1)}h) with high early PnL ${pnlPct}% — monitoring`);
    return { action: "HOLD", confidence: 0.5, reasons, risks: ["early_position"] };
  }

  // 7. Fee earnings check (minimum 0.01 SOL earned to be worth copying)
  const feesSol = position.feesEarnedSol ?? position.fees_earned_sol ?? position.unclaimed_fees_usd ?? 0;
  if (feesSol < 0.01 && (ageHours ?? 24) > 6) {
    reasons.push(`Low fee earnings ${feesSol} SOL after ${ageHours?.toFixed(1) ?? "?"}h`);
    return { action: "HOLD", confidence: 0.3, reasons, risks: ["low_fees"] };
  }

  // All checks passed — this position is worth copying
  const confidence = computeCopyConfidence(walletScore, rangeQuality, feeTvl, volatility, ageHours);
  reasons.push("All quality checks passed");
  return { action: "COPY", confidence, reasons, risks };
}

/**
 * Assess the quality of a position's bin range.
 * @param {Object} position
 * @returns {number} Range quality score 0-100
 */
export function assessRangeQuality(position) {
  const lowerBin = position.lowerBin ?? position.lower_bin;
  const upperBin = position.upperBin ?? position.upper_bin;
  const activeBin = position.activeBin ?? position.active_bin;

  if (lowerBin == null || upperBin == null || activeBin == null) return 50;

  const totalBins = Math.abs(upperBin - lowerBin);
  if (totalBins < 10) return 30; // Too narrow
  if (totalBins > 500) return 40; // Too wide

  // Check if active bin is within range
  const inRange = activeBin >= lowerBin && activeBin <= upperBin;
  const distanceFromActive = inRange ? 0 : Math.min(
    Math.abs(activeBin - lowerBin),
    Math.abs(activeBin - upperBin)
  );

  let score = 70; // Base score
  if (totalBins >= 35 && totalBins <= 100) score += 15; // Sweet spot
  if (totalBins > 100 && totalBins <= 200) score += 5;
  if (inRange) score += 10;
  if (!inRange && distanceFromActive > 50) score -= 20; // Far OOR

  return Math.max(0, Math.min(100, score));
}

/**
 * Compute overall confidence score for copying a position.
 * @param {number} walletScore - Wallet quality score 0-100
 * @param {number} rangeQuality - Range quality 0-100
 * @param {number} feeTvl - Fee/TVL ratio
 * @param {number} volatility - Pool volatility
 * @param {number|null} ageHours - Position age in hours
 * @returns {number} Confidence score 0-1
 */
function computeCopyConfidence(walletScore, rangeQuality, feeTvl, volatility, ageHours) {
  let confidence = 0;

  // Wallet score contribution (30%)
  confidence += 0.30 * (Math.min(walletScore, 100) / 100);

  // Range quality contribution (25%)
  confidence += 0.25 * (rangeQuality / 100);

  // Fee/TVL contribution (25%) — normalized to 0.05 baseline
  const feeScore = Math.min(feeTvl / 0.05, 1);
  confidence += 0.25 * feeScore;

  // Volatility contribution (20%) — lower is better for low-vol strategies
  const volScore = volatility <= 0 ? 0.5 : Math.max(0, 1 - (volatility / 10));
  confidence += 0.20 * volScore;

  // Age bonus — positions 6-48h old are ideal
  if (ageHours != null) {
    if (ageHours >= 4 && ageHours <= 72) confidence += 0.05;
    if (ageHours > 168) confidence -= 0.05; // Too old, might have decayed
  }

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Analyze a complete wallet and all its positions for copy suitability.
 * @param {Object} wallet - Complete wallet data with positions
 * @param {Object} [config]
 * @returns {Promise<{action: string, confidence: number, bestPosition: Object|null, reasons: string[], risks: string[]}>}
 */
export async function analyzeWalletForCopy(wallet, config = {}) {
  if (!wallet?.address) {
    return { action: "SKIP", confidence: 0, bestPosition: null, reasons: ["No wallet address"], risks: ["missing_data"] };
  }

  const positions = wallet.positions ?? wallet.rawData?.positions ?? [];
  if (!positions.length) {
    return { action: "HOLD", confidence: 0.2, bestPosition: null, reasons: ["No LP positions found"], risks: ["no_positions"] };
  }

  const walletMetrics = {
    score: wallet.score ?? wallet._score ?? 0,
    grade: wallet.grade ?? wallet._grade ?? "N/A",
  };

  // Analyze each position
  const results = await Promise.allSettled(
    positions.map(pos => analyzePositionForCopy(pos, walletMetrics, config))
  );

  // Find the best copy-worthy position
  const bestResult = results.reduce((best, r, i) => {
    if (r.status !== "fulfilled" || !r.value) return best;
    const result = r.value;
    if (result.action === "COPY" && result.confidence > (best?.confidence ?? 0)) {
      return { ...result, bestPosition: positions[i] };
    }
    return best;
  }, null);

  if (bestResult) {
    return bestResult;
  }

  // No position passed all checks — return the best HOLD result
  const bestHold = results.reduce((best, r, i) => {
    if (r.status !== "fulfilled" || !r.value) return best;
    if ((r.value.confidence ?? 0) > (best?.confidence ?? 0)) {
      return { ...r.value, bestPosition: positions[i] };
    }
    return best;
  }, null);

  return bestHold || {
    action: "SKIP",
    confidence: 0,
    bestPosition: null,
    reasons: ["No copy-worthy position found"],
    risks: ["all_positions_rejected"],
  };
}
