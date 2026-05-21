/**
 * position-manager.js
 * Rule-based position evaluation for Meridian DLMM LP.
 *
 * Returns structured action recommendations — does NOT execute trades.
 * Designed to be called from the management cycle in index.js so the
 * LLM agent receives pre-computed guidance instead of re-deriving it.
 *
 * Action values:
 *   HOLD            — within all thresholds, no action needed
 *   CLAIM_AND_HOLD  — fees are above threshold; claim but keep the position
 *   EXIT            — one or more exit conditions triggered
 *   EXIT_URGENT     — hard-stop condition (IL spike, rug signal)
 */

// ---------------------------------------------------------------------------
// Default rules (all overridable per-call)
// ---------------------------------------------------------------------------

export const DEFAULT_POSITION_RULES = {
  // Exit triggers — tuned for >70% win rate:
  // IL must be stopped early; fees rarely recover from >12% IL in DLMM
  maxIlFraction:      0.12,  // Exit if IL ≥ 12% of deployed capital (was 20%)
  maxHoldingDays:      7,    // Exit after 7 days — DLMM positions decay fast (was 14)
  profitTargetPct:    0.15,  // Take profit at 15% net return — compound faster (was 30%)
  minScoreToHold:     45,    // Exit if live pool score drops below 45 (was 30)
  hardStopIlFraction: 0.25,  // Urgent exit if IL ≥ 25% — no recovery possible (was 40%)
  devSoldExit:        true,  // Urgent exit if dev sold all tokens

  // Claim trigger — claim earlier to lock in gains
  claimFeeThresholdUsd: 3,   // Claim fees when ≥ $3 accrued (was $5)
};

// ---------------------------------------------------------------------------
// Single-position evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one active position against the rule set.
 *
 * @param {object} position   — position object from getMyPositions()
 * @param {object|null} scoredPool — pool with pool_score from screening (optional)
 * @param {number} solPriceUsd
 * @param {object} rules      — rule overrides
 * @returns {{ action, reason, urgency, position_summary }}
 */
export function evaluatePosition(
  position,
  scoredPool = null,
  solPriceUsd = 150,
  rules = DEFAULT_POSITION_RULES,
) {
  const r = { ...DEFAULT_POSITION_RULES, ...rules };

  const reasons = [];
  let action  = "HOLD";
  let urgency = "low";

  // ── Derived fields ────────────────────────────────────────────────────────

  const deployedAt    = new Date(position.deployed_at ?? Date.now());
  const holdingDays   = (Date.now() - deployedAt.getTime()) / 86_400_000;
  const ilFraction    = Number(position.il_pct  ?? position.il_fraction ?? 0) / 100;
  const pnlUsd        = Number(position.pnl_usd ?? 0);
  const feesEarnedUsd = Number(
    position.fees_earned_usd ??
    (position.fees_earned_sol != null ? position.fees_earned_sol * solPriceUsd : 0)
  );
  const deployUsd = Number(
    position.deploy_amount_usd ??
    (position.deploy_amount_sol != null ? position.deploy_amount_sol * solPriceUsd : 0)
  );
  const netReturnPct = deployUsd > 0 ? pnlUsd / deployUsd : 0;
  const poolScore    = scoredPool?.pool_score ?? null;

  // ── Hard-stop checks (URGENT) ─────────────────────────────────────────────

  if (ilFraction >= r.hardStopIlFraction) {
    return buildResult("EXIT_URGENT", urgency = "critical",
      [`IL ${(ilFraction * 100).toFixed(1)}% ≥ hard-stop ${r.hardStopIlFraction * 100}%`],
      { holdingDays, ilFraction, pnlUsd, feesEarnedUsd, deployUsd, netReturnPct, poolScore });
  }

  if (r.devSoldExit && position.dev_sold_all === true) {
    return buildResult("EXIT_URGENT", urgency = "critical",
      ["dev sold all tokens — rug risk"],
      { holdingDays, ilFraction, pnlUsd, feesEarnedUsd, deployUsd, netReturnPct, poolScore });
  }

  if (position.is_rugpull === true) {
    return buildResult("EXIT_URGENT", urgency = "critical",
      ["rugpull flagged by OKX"],
      { holdingDays, ilFraction, pnlUsd, feesEarnedUsd, deployUsd, netReturnPct, poolScore });
  }

  // ── Standard exit checks ──────────────────────────────────────────────────

  if (ilFraction >= r.maxIlFraction) {
    action  = "EXIT";
    urgency = "high";
    reasons.push(`IL ${(ilFraction * 100).toFixed(1)}% ≥ max ${r.maxIlFraction * 100}%`);
  }

  if (holdingDays >= r.maxHoldingDays) {
    action  = "EXIT";
    if (urgency !== "high") urgency = "medium";
    reasons.push(`held ${holdingDays.toFixed(1)}d ≥ max ${r.maxHoldingDays}d`);
  }

  if (netReturnPct >= r.profitTargetPct) {
    action  = "EXIT";
    if (urgency === "low") urgency = "medium";
    reasons.push(`profit target +${(netReturnPct * 100).toFixed(1)}% ≥ ${r.profitTargetPct * 100}%`);
  }

  if (poolScore !== null && poolScore < r.minScoreToHold) {
    action  = "EXIT";
    if (urgency === "low") urgency = "medium";
    reasons.push(`pool score ${poolScore} < min-to-hold ${r.minScoreToHold}`);
  }

  // Pool grade hard-skip: if the live score now calls this pool SKIP, exit
  if (scoredPool?.pool_recommendation === "SKIP" && action === "HOLD") {
    action  = "EXIT";
    urgency = "medium";
    reasons.push(`live pool recommendation changed to SKIP`);
  }

  // ── Fee claim check ───────────────────────────────────────────────────────

  if (feesEarnedUsd >= r.claimFeeThresholdUsd) {
    if (action === "HOLD") {
      action = "CLAIM_AND_HOLD";
    }
    reasons.push(`fees $${feesEarnedUsd.toFixed(2)} ≥ claim threshold $${r.claimFeeThresholdUsd}`);
  }

  if (reasons.length === 0) reasons.push("within all thresholds");

  return buildResult(action, urgency, reasons, { holdingDays, ilFraction, pnlUsd, feesEarnedUsd, deployUsd, netReturnPct, poolScore });
}

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate all active positions.
 *
 * @param {object[]} positions  — from getMyPositions()
 * @param {object[]} scoredPools — from getTopCandidates() or pool-scorer
 * @param {number} solPriceUsd
 * @param {object} rules
 * @returns {object[]} sorted: EXIT_URGENT → EXIT → CLAIM_AND_HOLD → HOLD
 */
export function evaluateAllPositions(
  positions = [],
  scoredPools = [],
  solPriceUsd = 150,
  rules = DEFAULT_POSITION_RULES,
) {
  const poolMap = new Map(scoredPools.map((p) => [p.pool, p]));

  const results = positions.map((pos) => {
    const scoredPool = poolMap.get(pos.pool) ?? null;
    const ev = evaluatePosition(pos, scoredPool, solPriceUsd, rules);
    return {
      pool:        pos.pool,
      name:        pos.name ?? pos.pool?.slice(0, 8),
      base_symbol: pos.base_symbol ?? pos.base?.symbol ?? "?",
      ...ev,
    };
  });

  const ORDER = { EXIT_URGENT: 0, EXIT: 1, CLAIM_AND_HOLD: 2, HOLD: 3 };
  results.sort((a, b) => (ORDER[a.action] ?? 4) - (ORDER[b.action] ?? 4));
  return results;
}

// ---------------------------------------------------------------------------
// Summary printer (for CLI / Telegram)
// ---------------------------------------------------------------------------

export function printPositionReport(evaluations) {
  if (evaluations.length === 0) {
    console.log("  No active positions.");
    return;
  }
  console.log(`\n${"─".repeat(72)}`);
  console.log("  POSITION MANAGER REPORT");
  console.log(`${"─".repeat(72)}`);
  for (const ev of evaluations) {
    const sym    = ev.base_symbol.padEnd(10);
    const action = ev.action.padEnd(14);
    const urgBadge = ev.urgency === "critical" ? " ⚠ URGENT" : ev.urgency === "high" ? " !" : "";
    console.log(`  [${ev.action === "HOLD" || ev.action === "CLAIM_AND_HOLD" ? "✓" : "✗"}] ${sym} → ${action}${urgBadge}`);
    console.log(`      IL: ${(ev.position_summary.ilFraction * 100).toFixed(1)}%  ` +
                `PnL: $${ev.position_summary.pnlUsd.toFixed(2)}  ` +
                `Fees: $${ev.position_summary.feesEarnedUsd.toFixed(2)}  ` +
                `Held: ${ev.position_summary.holdingDays.toFixed(1)}d` +
                (ev.position_summary.poolScore !== null ? `  Score: ${ev.position_summary.poolScore}` : ""));
    console.log(`      Reason: ${ev.reason}`);
  }
  console.log(`${"─".repeat(72)}\n`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildResult(action, urgency, reasons, summary) {
  return {
    action,
    urgency,
    reason: reasons.join("; "),
    position_summary: summary,
  };
}
