/**
 * ranking/scorer.js
 * Smart Top 10 Selection — Scoring Engine
 *
 * NOW delegates to scoring/composite-scorer.js for advanced multi-layer scoring.
 * Maintains backward compatibility for all existing callers.
 *
 * Old mode mapping:
 *   auto_top_10  → balanced
 *   conservative → conservative
 *   aggressive   → aggressive
 *   manual       → hybrid
 *   (new) momentum → momentum
 *   (new) hybrid   → hybrid
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import {
  scoreWalletAdvanced,
  rankWalletsAdvanced,
  scoreSingleWallet,
} from "../scoring/composite-scorer.js";

// ─── Mode Mapping ──────────────────────────────────────────────

const MODE_MAP = {
  auto_top_10: "balanced",
  conservative: "conservative",
  aggressive: "aggressive",
  manual: "hybrid",
  momentum: "momentum",
  balanced: "balanced",
  hybrid: "hybrid",
};

function mapMode(mode) {
  return MODE_MAP[mode] || "balanced";
}

// ─── Composite Scoring (delegates to scoring engine) ──────────

/**
 * Compute weighted composite score for a single wallet.
 * Delegates to scoring/composite-scorer.js for advanced factors.
 *
 * @param {object} walletData — Normalized wallet metrics
 * @param {string} [strategyMode] — Override strategy mode
 * @returns {{ score: number, breakdown: object, grade: string, mode: string }}
 */
export function scoreWallet(walletData, strategyMode) {
  const mode = strategyMode || config.ranking?.strategyMode || "auto_top_10";
  const mappedMode = mapMode(mode);

  const result = scoreWalletAdvanced(walletData, mappedMode);

  // Map back to the old return format for backward compatibility
  return {
    score: result.score,
    grade: result.grade,
    breakdown: translateBreakdown(result.factors),
    mode,
    // New fields (added without breaking old callers)
    gradeLabel: result.gradeLabel,
    groups: result.groups,
    riskProfile: result.riskProfile,
  };
}

/**
 * Translate new factor format to old breakdown format.
 */
function translateBreakdown(factors) {
  const oldFormat = {};
  for (const [key, factor] of Object.entries(factors || {})) {
    oldFormat[key] = {
      raw: factor.raw,
      normalized: factor.score,
      weight: factor.weight,
      contribution: factor.contribution,
      reason: factor.reason,
      sentiment: factor.sentiment,
    };
  }
  return oldFormat;
}

/**
 * Score and rank a list of wallets.
 * Delegates to scoring/composite-scorer.js for advanced ranking.
 *
 * @param {Array<object>} wallets — Array of wallet data objects
 * @param {string} [strategyMode]
 * @returns {Array<object>} Sorted array with rank, score, grade, breakdown
 */
export function rankWallets(wallets, strategyMode) {
  const mode = strategyMode || config.ranking?.strategyMode || "auto_top_10";
  const mappedMode = mapMode(mode);

  const ranked = rankWalletsAdvanced(wallets, mappedMode);

  // Ensure backward-compatible output format
  return ranked.map((w) => ({
    address: w.address,
    label: w.label || w.name || w.address?.slice(0, 8),
    score: w.score,
    grade: w.grade,
    rank: w.rank,
    breakdown: translateBreakdown(w.factors),
    mode,
    rawData: {
      pnl7d: w.rawMetrics?.pnl7d,
      pnl30d: w.rawMetrics?.pnl30d,
      feesEarned: w.rawMetrics?.feesEarned,
      winRate: w.rawMetrics?.winRate,
      maxDrawdownPct: w.rawMetrics?.maxDrawdownPct,
      daysActive30d: w.rawMetrics?.daysActive30d,
      lpVolumeSol: w.rawMetrics?.lpVolumeSol,
      lastSeen: w.rawMetrics?.lastSeen,
      source: w.rawMetrics?.source,
    },
    // New fields
    groups: w.groups,
    riskProfile: w.riskProfile,
    factorCount: w.factorCount,
  }));
}

// ─── Quick Score (single wallet) ───────────────────────────────

/**
 * Score a single wallet quickly.
 * Delegates to scoring engine.
 *
 * @param {string} address
 * @param {object} metrics
 * @param {string} [strategyMode]
 * @returns {object}
 */
export function scoreSingleWalletQuick(address, metrics, strategyMode) {
  const mode = strategyMode || config.ranking?.strategyMode || "auto_top_10";
  const mappedMode = mapMode(mode);
  return scoreSingleWallet(address, metrics, mappedMode);
}

// ─── Exported weight profiles for UI config ────────────────────

import { getWeightProfile as getScoringProfile, getAvailableModes as getScoringModes, WEIGHT_PROFILES } from "../scoring/weight-profiles.js";

export function getWeightProfile(mode) {
  return getScoringProfile(mapMode(mode));
}

export function getAvailableModes() {
  return [...Object.keys(MODE_MAP), ...getScoringModes()];
}
