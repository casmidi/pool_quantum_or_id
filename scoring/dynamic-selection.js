/**
 * scoring/dynamic-selection.js
 * Dynamic Top N Wallet Selection with intelligent filtering.
 *
 * Features:
 *   - Configurable top N (default 10)
 *   - Whitelist (always include specific wallets)
 *   - Blacklist (exclude specific wallets)
 *   - Performance decay detection (auto-exclude declining wallets)
 *   - Correlation check between top wallets
 *   - Minimum criteria enforcement
 *   - Auto-rebalance recommendations
 */

import { log } from "../logger.js";
import { getWeightProfile } from "./weight-profiles.js";
import { scoreWalletAdvanced } from "./composite-scorer.js";

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULTS = {
  topN: 10,
  minScore: 20,          // minimum score to be considered
  decayLookback: 3,       // number of snapshots to check for decay
  decayThreshold: -15,    // score drop > this = performance decay
  maxCorrelation: 0.85,   // max allowed correlation between any 2 wallets
  excludeZeroScore: true, // exclude wallets with missing data
};

// ─── Performance Decay Detection ──────────────────────────────

/**
 * Detect if a wallet is experiencing performance decay.
 * Compares current score against recent historical scores.
 *
 * @param {object} wallet — Wallet with score and history
 * @param {number} lookback — Number of historical snapshots to check
 * @param {number} threshold — Score drop threshold to trigger detection
 * @returns {{ decaying: boolean, drop: number, reason: string }}
 */
export function detectDecay(wallet, lookback = DEFAULTS.decayLookback, threshold = DEFAULTS.decayThreshold) {
  if (!wallet.scoreHistory || wallet.scoreHistory.length < 2) {
    return { decaying: false, drop: 0, reason: "insufficient history" };
  }

  const recent = wallet.scoreHistory.slice(-lookback);
  const firstScore = recent[0];
  const lastScore = recent[recent.length - 1];
  const drop = lastScore - firstScore;

  if (drop <= threshold) {
    return {
      decaying: true,
      drop,
      reason: `Score dropped ${drop.toFixed(1)}pts over last ${recent.length} snapshots`,
    };
  }

  // Check for consistent decline trend
  let consecutiveDeclines = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] < recent[i - 1]) consecutiveDeclines++;
  }

  if (consecutiveDeclines >= lookback - 1 && drop < 0) {
    return {
      decaying: true,
      drop,
      reason: `Consistent decline: ${consecutiveDeclines}/${lookback - 1} snapshots dropping`,
    };
  }

  return { decaying: false, drop, reason: "stable or improving" };
}

// ─── Correlation Check ────────────────────────────────────────

/**
 * Check pairwise correlation between wallets in the top list.
 * If two wallets are highly correlated, one may be redundant.
 *
 * Uses score history similarity as correlation proxy.
 *
 * @param {Array<object>} wallets — Array of scored wallets with scoreHistory
 * @param {number} maxCorrelation
 * @returns {Array<{ a: string, b: string, correlation: number, action: string }>}
 */
export function checkCorrelation(wallets, maxCorrelation = DEFAULTS.maxCorrelation) {
  const conflicts = [];

  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const a = wallets[i];
      const b = wallets[j];

      const histA = a.scoreHistory || [];
      const histB = b.scoreHistory || [];
      const minLen = Math.min(histA.length, histB.length);

      if (minLen < 3) continue;

      // Simple correlation: compare recent score movements
      const recentA = histA.slice(-minLen);
      const recentB = histB.slice(-minLen);

      let sameDirection = 0;
      for (let k = 1; k < minLen; k++) {
        const dirA = recentA[k] - recentA[k - 1];
        const dirB = recentB[k] - recentB[k - 1];
        if ((dirA > 0 && dirB > 0) || (dirA < 0 && dirB < 0)) {
          sameDirection++;
        }
      }

      const correlation = sameDirection / (minLen - 1);
      if (correlation >= maxCorrelation) {
        // Keep the higher-scored wallet, flag the other
        const [keep, remove] = a.score >= b.score ? [a, b] : [b, a];
        conflicts.push({
          a: a.address.slice(0, 12),
          b: b.address.slice(0, 12),
          correlation: parseFloat(correlation.toFixed(2)),
          action: `Consider removing ${remove.label || remove.address.slice(0, 8)} (correlated with ${keep.label || keep.address.slice(0, 8)})`,
        });
      }
    }
  }

  return conflicts;
}

// ─── Selection Engine ──────────────────────────────────────────

/**
 * Select top N wallets with intelligent filtering.
 *
 * Pipeline:
 *   1. Score all candidate wallets
 *   2. Apply minimum score filter
 *   3. Enforce whitelist (bypass filters)
 *   4. Enforce blacklist (always exclude)
 *   5. Detect and flag performance decay
 *   6. Sort by score and take top N
 *   7. Check correlation among top N
 *   8. Return selection with diagnostics
 *
 * @param {Array<object>} candidateWallets — Array of { address, label, ...metrics }
 * @param {object} [options]
 * @param {number}  [options.topN=10]
 * @param {string}  [options.mode="balanced"]
 * @param {string[]} [options.whitelist=[]]   — Always include these addresses
 * @param {string[]} [options.blacklist=[]]   — Always exclude these addresses
 * @param {number}  [options.minScore]        — Minimum score threshold
 * @param {boolean} [options.autoExcludeDecaying=true] — Auto-exclude decaying wallets
 * @param {boolean} [options.checkCorrelation=true]    — Flag correlated wallets
 * @returns {object} Selection result
 */
export function selectTopWallets(candidateWallets, options = {}) {
  const topN = options.topN ?? options.count ?? DEFAULTS.topN;
  const mode = options.mode || "balanced";
  const whitelist = new Set((options.whitelist || []).map((a) => a.toLowerCase()));
  const blacklist = new Set((options.blacklist || []).map((a) => a.toLowerCase()));
  const minScore = options.minScore ?? DEFAULTS.minScore;
  const autoExcludeDecaying = options.autoExcludeDecaying ?? true;
  const shouldCheckCorrelation = options.checkCorrelation ?? true;

  log("scoring", `Selecting top ${topN} from ${candidateWallets.length} candidates (mode=${mode})`);

  if (candidateWallets.length === 0) {
    return {
      selected: [],
      totalCandidates: 0,
      filtered: { belowMinScore: 0, blacklisted: 0, decaying: 0, noData: 0 },
      warnings: ["No candidates provided"],
      correlations: [],
      mode,
    };
  }

  const filtered = { belowMinScore: 0, blacklisted: 0, decaying: 0, noData: 0 };
  const warnings = [];
  const eligible = [];

  // ── Score all candidates ──
  const scoredWallets = candidateWallets.map((w) => {
    // Skip if blacklisted
    if (blacklist.has(w.address?.toLowerCase())) {
      filtered.blacklisted++;
      return null;
    }

    // Run scoring engine
    const scoreResult = scoreWalletAdvanced(w, mode);

    // Check minimum score
    if (scoreResult.score < minScore && !whitelist.has(w.address?.toLowerCase())) {
      filtered.belowMinScore++;
      return null;
    }

    // Check zero score (missing data)
    if (DEFAULTS.excludeZeroScore && scoreResult.score === 0) {
      filtered.noData++;
      return null;
    }

    return {
      address: w.address,
      label: w.label || w.name || w.address?.slice(0, 8),
      ...scoreResult,
      scoreHistory: w.scoreHistory || [],
      isWhitelisted: whitelist.has(w.address?.toLowerCase()),
    };
  }).filter(Boolean);

  // ── Detect decay ──
  const afterDecay = [];
  for (const w of scoredWallets) {
    if (w.isWhitelisted) {
      afterDecay.push(w);
      continue;
    }

    const decay = detectDecay(w);
    if (autoExcludeDecaying && decay.decaying) {
      filtered.decaying++;
      warnings.push(`${w.label}: ${decay.reason}`);
      continue;
    }

    afterDecay.push(w);
  }

  // ── Sort and take top N ──
  afterDecay.sort((a, b) => b.score - a.score);
  const selected = afterDecay.slice(0, topN);
  selected.forEach((wallet, index) => {
    wallet.rank = index + 1;
  });

  // ── Correlation check ──
  const correlations = shouldCheckCorrelation ? checkCorrelation(selected) : [];
  for (const c of correlations) {
    warnings.push(c.action);
  }

  // ── Summary ──
  const totalProcessed = candidateWallets.length;
  const totalExcluded = filtered.belowMinScore + filtered.blacklisted + filtered.decaying + filtered.noData;

  log("scoring", `Selected ${selected.length}/${totalProcessed}: ${totalExcluded} excluded ` +
    `(score=${filtered.belowMinScore}, blacklist=${filtered.blacklisted}, ` +
    `decay=${filtered.decaying}, nodata=${filtered.noData})` +
    (warnings.length > 0 ? ` — ${warnings.length} warnings` : ""));

  return {
    selected,
    totalCandidates: totalProcessed,
    totalExcluded,
    filtered,
    warnings,
    correlations,
    mode,
  };
}

/**
 * Format selection result for Telegram/CLI display.
 * @param {object} selection — Result from selectTopWallets
 * @returns {string}
 */
export function formatSelection(selection) {
  if (!selection?.selected?.length) {
    return "📊 *Top Wallets*\n\nNo wallets selected.";
  }

  const lines = [
    `📊 *Top ${selection.selected.length} Wallets* (${selection.mode})`,
    `Candidates: ${selection.totalCandidates} | Excluded: ${selection.totalExcluded}`,
    "",
  ];

  for (const w of selection.selected) {
    const whitelistBadge = w.isWhitelisted ? " ⭐" : "";
    lines.push(
      `${w.rank ?? "?"}. *${w.label}*${whitelistBadge}`,
      `   Score: ${w.score}/100 (${w.grade}) | Risk: ${w.riskProfile}`,
      w.factors ? `   PnL: ${w.factors?.pnl_7d?.contribution ?? "?"} | Risk: ${w.factors?.max_drawdown?.score ?? "?"}` : "",
    );
  }

  if (selection.warnings.length > 0) {
    lines.push("", "⚠️ *Warnings:*");
    for (const w of selection.warnings.slice(0, 5)) {
      lines.push(`• ${w}`);
    }
  }

  if (selection.correlations?.length > 0) {
    lines.push("", "🔄 *Correlation Flags:*");
    for (const c of selection.correlations.slice(0, 3)) {
      lines.push(`• ${c.a} ↔ ${c.b}: ${(c.correlation * 100).toFixed(0)}%`);
    }
  }

  return lines.join("\n");
}

export { DEFAULTS };
