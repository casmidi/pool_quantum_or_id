/**
 * pool-scorer.js
 * Systematic pool scoring engine for Meridian DLMM LP strategy.
 * Scores each pool 0–100 based on fee efficiency, token quality,
 * activity trends, and risk signals — analogous to TradingSystem's
 * quantum strategy signal scoring.
 */

// ---------------------------------------------------------------------------
// Default weights (total = 100 base points, penalties applied on top)
// ---------------------------------------------------------------------------
export const DEFAULT_WEIGHTS = {
  // === RETURN SIGNALS (57 pts) ===
  fee_active_tvl_ratio: 22,   // Primary yield signal — fee earned per $ active TVL
  volume_window:         8,   // Trading activity (raw volume is noisy — use sparingly)
  fee_change_pct:        9,   // Growing fees = momentum, best leading indicator of sustained yield
  volume_change_pct:     4,   // Volume trend (weaker predictor than fee trend)
  active_pct:           11,   // In-range time — critical: out-of-range = zero fee, IL continues
  volatility_zone:       3,   // Volatility zone fit: medium (1-4%) rewarded, extreme penalized

  // === TOKEN QUALITY (28 pts) ===
  organic_score:        14,   // Jupiter organic score — anti-wash, sustainable volume
  holders:               7,   // Token holder distribution
  token_age:             7,   // Older tokens = less rug risk, more price stability

  // === SMART MONEY / SOCIAL (15 pts) ===
  smart_money:           8,   // KOL clusters + smart money buy signal
  discord_signal:        4,   // Discord catalyst signal
  price_trend:           3,   // Price trend direction

  // === RISK PENALTIES (subtracted) ===
  // Applied as negative adjustments after base score calculation
};

export const DEFAULT_PENALTY_CONFIG = {
  pvp:              15,   // Competing pool for same token (IL risk + split liquidity)
  ath_pct:          15,   // Price near ATH — raised: dump risk is the #1 IL cause
  bundle_pct:       12,   // Bundler activity % — indicates artificial inflation
  sniper_pct:        8,   // Sniper bot % — short-term dump risk
  dev_sold:         20,   // Dev sold all tokens — highest rug risk signal
  wash_trading:     50,   // Wash trading detected — fee yield is fake (hard reject)
  extreme_fee_spike: 8,
  no_volatility:     8,   // Volatility missing or zero — can't calculate IL properly
  extreme_volatility: 10, // >10% volatility — IL will outrun fee yield in most periods
};

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Clamp value between 0–1, then scale to 0–maxPts */
function normLinear(value, min, max, maxPts) {
  if (value == null || !Number.isFinite(value)) return 0;
  const clamped = Math.max(min, Math.min(max, value));
  return ((clamped - min) / (max - min)) * maxPts;
}

/** Log-scale normalization — good for skewed distributions like volume/TVL */
function normLog(value, min, max, maxPts) {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  const logVal = Math.log10(Math.max(min, Math.min(max, value)));
  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  return ((logVal - logMin) / (logMax - logMin)) * maxPts;
}

/** Bell-curve normalization — rewards values near a sweet spot */
function normBell(value, center, spread, maxPts) {
  if (value == null || !Number.isFinite(value)) return 0;
  const distance = Math.abs(value - center);
  return Math.max(0, maxPts * Math.exp(-0.5 * Math.pow(distance / spread, 2)));
}

// ---------------------------------------------------------------------------
// Individual signal scorers
// ---------------------------------------------------------------------------

function scoreFeeActiveTvlRatio(pool, maxPts) {
  const ratio = Number(pool.fee_active_tvl_ratio ?? 0);
  // Range calibrated for 5m timeframe (bot default) and 30m timeframe (dry-scan):
  // 0.003–0.050 covers the realistic deployable pool universe.
  // Bell curve peaks around 0.020 — high enough to matter, not so extreme it's a spike.
  return normLog(ratio, 0.001, 0.50, maxPts);
}

function scoreVolume(pool, maxPts) {
  const vol = Number(pool.volume_window ?? 0);
  // Log scale: $500 min, $500k+ = full score
  return normLog(vol, 500, 500_000, maxPts);
}

function scoreFeeChange(pool, maxPts) {
  const change = Number(pool.fee_change_pct ?? 0);
  // Growing fees: +10% → 50% of max; -20%+ → 0
  return normLinear(change, -20, 50, maxPts);
}

function scoreVolumeChange(pool, maxPts) {
  const change = Number(pool.volume_change_pct ?? 0);
  return normLinear(change, -20, 50, maxPts);
}

function scoreActivePct(pool, maxPts) {
  const pct = Number(pool.active_pct ?? 0);
  // Higher in-range % = better fee capture
  return normLinear(pct, 20, 100, maxPts);
}

function scoreOrganic(pool, maxPts) {
  const score = Number(pool.organic_score ?? pool.base?.organic ?? 0);
  // 70 = minimum (screening enforced), 95+ = excellent. Linear pressure to push toward high organic.
  // Relaxed: organic 60+ gets non-zero score. 60→~3pts, 80→~8pts, 95+→full 14pts.
  return normLinear(score, 60, 97, maxPts);
}

function scoreHolders(pool, maxPts) {
  const h = Number(pool.holders ?? 0);
  // Log scale: 500 min, 10k+ = full score
  return normLog(h, 500, 10_000, maxPts);
}

function scoreTokenAge(pool, maxPts) {
  const ageHours = Number(pool.token_age_hours ?? 0);
  // <24h: very risky (rug, dev dump). 72h–168h (3–7d): sweet spot (momentum + stability).
  // >720h (30d): established, lower rug risk but also lower momentum.
  if (ageHours < 24)   return maxPts * 0.1;  // new token: high rug risk
  if (ageHours < 48)   return maxPts * 0.35; // 1-2d: still risky
  if (ageHours > 2160) return maxPts * 0.75; // >90d: established, slightly discounted
  return normLinear(ageHours, 48, 720, maxPts);
}

function scoreVolatilityZone(pool, maxPts) {
  // DLMM LP sweet spot — widened to include higher vol (profitable with wider ranges).
  // Low = low fees. Medium-high = ideal fee capture with DLMM edge planner.
  const v = Number(pool.volatility ?? 0);
  if (v <= 0) return 0;
  if (v < 0.75) return maxPts * 0.35;
  if (v < 1.5)  return maxPts * 0.75;
  if (v <= 5.0) return maxPts; // widened from 3.5 → 5.0 — edge planner handles high vol
  if (v <= 8.0) return maxPts * 0.45;
  return 0;
}


function scoreSmartMoney(pool, maxPts) {
  let pts = 0;
  if (pool.smart_money_buy === true) pts += maxPts * 0.5;
  if (pool.kol_in_clusters === true) pts += maxPts * 0.35;
  const trend = String(pool.top_cluster_trend || "").toLowerCase();
  if (trend === "buy") pts += maxPts * 0.15;
  else if (trend === "sell") pts -= maxPts * 0.2;
  return Math.max(0, Math.min(maxPts, pts));
}

function scoreDiscordSignal(pool, maxPts) {
  if (!pool.discord_signal) return 0;
  const count = Number(pool.discord_signal_count ?? 1);
  // More signal sources = stronger conviction
  return normLinear(count, 1, 5, maxPts);
}

function scorePriceTrend(pool, maxPts) {
  const trend = String(pool.price_trend || "").toLowerCase();
  if (trend === "up")     return maxPts;
  if (trend === "stable") return maxPts * 0.5;
  if (trend === "down")   return maxPts * 0.1;
  return maxPts * 0.3; // unknown
}

// ---------------------------------------------------------------------------
// Risk penalties
// ---------------------------------------------------------------------------

function calcPenalties(pool, penaltyConfig) {
  const reasons = [];
  let totalPenalty = 0;

  // Wash trading — hard reject
  if (pool.is_wash === true) {
    reasons.push({ reason: "wash trading detected", penalty: penaltyConfig.wash_trading });
    totalPenalty += penaltyConfig.wash_trading;
  }

  // Dev sold all
  if (pool.dev_sold_all === true) {
    reasons.push({ reason: "dev sold all tokens", penalty: penaltyConfig.dev_sold });
    totalPenalty += penaltyConfig.dev_sold;
  }

  // PVP risk (competing pool)
  if (pool.is_pvp === true || pool.pvp_risk === "high") {
    reasons.push({ reason: "competing pool (PVP risk)", penalty: penaltyConfig.pvp });
    totalPenalty += penaltyConfig.pvp;
  }

  // Price near ATH
  const athPct = Number(pool.price_vs_ath_pct ?? 0);
  if (athPct > 80) {
    const severity = ((athPct - 80) / 20) * penaltyConfig.ath_pct;
    reasons.push({ reason: `price at ${athPct.toFixed(0)}% of ATH`, penalty: Math.round(severity) });
    totalPenalty += severity;
  }

  // Bundle activity
  const bundlePct = Number(pool.bundle_pct ?? 0);
  if (bundlePct > 15) {
    const severity = ((bundlePct - 15) / 85) * penaltyConfig.bundle_pct;
    reasons.push({ reason: `bundle activity ${bundlePct.toFixed(0)}%`, penalty: Math.round(severity) });
    totalPenalty += severity;
  }

  // Sniper activity
  const sniperPct = Number(pool.sniper_pct ?? 0);
  if (sniperPct > 20) {
    const severity = ((sniperPct - 20) / 80) * penaltyConfig.sniper_pct;
    reasons.push({ reason: `sniper activity ${sniperPct.toFixed(0)}%`, penalty: Math.round(severity) });
    totalPenalty += severity;
  }

  // Missing volatility
  const vol = Number(pool.volatility ?? -1);
  if (!Number.isFinite(vol) || vol <= 0) {
    reasons.push({ reason: "volatility data unavailable", penalty: penaltyConfig.no_volatility });
    totalPenalty += penaltyConfig.no_volatility;
  } else if (vol > 5) {
    // Extreme volatility: IL will outrun fee yield in most 30m periods
    reasons.push({ reason: `extreme volatility ${vol.toFixed(2)} — IL risk very high`, penalty: penaltyConfig.extreme_volatility });
    totalPenalty += penaltyConfig.extreme_volatility;
  }

  const feeRatio = Number(pool.fee_active_tvl_ratio ?? 0);
  if (Number.isFinite(feeRatio) && feeRatio > 0.75) {
    const severity = Math.min(penaltyConfig.extreme_fee_spike, (feeRatio - 0.75) * 2);
    reasons.push({ reason: `extreme fee/active-TVL spike ${feeRatio.toFixed(3)}`, penalty: Math.round(severity) });
    totalPenalty += severity;
  }

  return { totalPenalty: Math.round(totalPenalty), reasons };
}

// ---------------------------------------------------------------------------
// Volatility zone classification
// ---------------------------------------------------------------------------

function classifyVolatility(volatility) {
  const v = Number(volatility ?? 0);
  if (v <= 0) return "unknown";
  if (v < 0.75) return "low";
  if (v <= 3.5) return "medium";
  if (v <= 5) return "high";
  return "extreme";
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

/**
 * Score a single pool. Returns score 0–100 and full breakdown.
 * @param {object} pool - condensed pool object from screening.js
 * @param {object} weights - optional weight overrides
 * @param {object} penaltyConfig - optional penalty overrides
 * @returns {{ score: number, grade: string, recommendation: string, breakdown: object, penalties: object }}
 */
export function scorePool(pool, weights = DEFAULT_WEIGHTS, penaltyConfig = DEFAULT_PENALTY_CONFIG) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const p = { ...DEFAULT_PENALTY_CONFIG, ...penaltyConfig };

  const signals = {
    fee_active_tvl_ratio: scoreFeeActiveTvlRatio(pool, w.fee_active_tvl_ratio),
    volume_window:        scoreVolume(pool, w.volume_window),
    fee_change_pct:       scoreFeeChange(pool, w.fee_change_pct),
    volume_change_pct:    scoreVolumeChange(pool, w.volume_change_pct),
    active_pct:           scoreActivePct(pool, w.active_pct),
    volatility_zone:      scoreVolatilityZone(pool, w.volatility_zone ?? 3),
    organic_score:        scoreOrganic(pool, w.organic_score),
    holders:              scoreHolders(pool, w.holders),
    token_age:            scoreTokenAge(pool, w.token_age),
    smart_money:          scoreSmartMoney(pool, w.smart_money),
    discord_signal:       scoreDiscordSignal(pool, w.discord_signal),
    price_trend:          scorePriceTrend(pool, w.price_trend),
  };

  const baseScore = Object.values(signals).reduce((sum, v) => sum + v, 0);
  const { totalPenalty, reasons: penaltyReasons } = calcPenalties(pool, p);
  const rawScore = Math.max(0, Math.min(100, Math.round(baseScore - totalPenalty)));

  // Grade — relaxed thresholds calibrated for broader pool universe.
  // A = STRONG DEPLOY (high conviction). B = DEPLOY (good candidate).
  // C = HOLD/LLM-DECIDE (pass to agent for narrative+risk eval).
  // D = SKIP (only worst-of-the-worst filtered before LLM sees).
  let grade, recommendation;
  if (rawScore >= 55) { grade = "A"; recommendation = "DEPLOY"; }
  else if (rawScore >= 40) { grade = "B"; recommendation = "DEPLOY"; }
  else if (rawScore >= 25) { grade = "C"; recommendation = "HOLD"; }
  else { grade = "D"; recommendation = "SKIP"; }

  // Override: wash trading or dev sold = hard SKIP
  if (pool.is_wash || pool.dev_sold_all) recommendation = "SKIP";

  return {
    pool:  pool.pool,
    name:  pool.name,
    score: rawScore,
    grade,
    recommendation,
    volatility_zone: classifyVolatility(pool.volatility),
    breakdown: {
      signals: Object.fromEntries(
        Object.entries(signals).map(([k, v]) => [k, Math.round(v * 10) / 10])
      ),
      base_score:    Math.round(baseScore),
      total_penalty: totalPenalty,
      final_score:   rawScore,
    },
    penalties: {
      total: totalPenalty,
      reasons: penaltyReasons,
    },
    raw: {
      fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
      volume_window:        pool.volume_window,
      fee_change_pct:       pool.fee_change_pct,
      volume_change_pct:    pool.volume_change_pct,
      active_pct:           pool.active_pct,
      organic_score:        pool.organic_score,
      holders:              pool.holders,
      token_age_hours:      pool.token_age_hours,
      volatility:           pool.volatility,
      bin_step:             pool.bin_step,
      tvl:                  pool.tvl,
      mcap:                 pool.mcap,
    },
  };
}

/**
 * Score and rank a list of pools. Returns sorted descending by score.
 * @param {object[]} pools - array of condensed pool objects
 * @param {object} weights - optional weight overrides
 * @returns {object[]} scored and ranked pools
 */
export function rankPools(pools, weights = DEFAULT_WEIGHTS) {
  return pools
    .map((pool) => scorePool(pool, weights))
    .sort((a, b) => b.score - a.score);
}

/**
 * Apply Darwin signal weights from signal-weights.json to scoring weights.
 * Signals that historically predict winners get boosted.
 * @param {object} darwinWeights - { signal_name: multiplier } from signal-weights.js
 * @returns {object} adjusted weights
 */
export function applyDarwinWeights(darwinWeights = {}) {
  const adjusted = { ...DEFAULT_WEIGHTS };
  const signalMap = {
    fee_yield_signal:     "fee_active_tvl_ratio",
    volume_signal:        "volume_window",
    organic_signal:       "organic_score",
    holder_signal:        "holders",
    smart_money_signal:   "smart_money",
    discord_signal:       "discord_signal",
    trend_signal:         "price_trend",
  };
  for (const [darwinKey, scorerKey] of Object.entries(signalMap)) {
    const mult = Number(darwinWeights[darwinKey] ?? 1.0);
    if (Number.isFinite(mult) && mult > 0 && adjusted[scorerKey] != null) {
      adjusted[scorerKey] = Math.round(adjusted[scorerKey] * mult * 10) / 10;
    }
  }
  return adjusted;
}

/**
 * Pretty-print a scored pool result to console.
 */
export function printScore(result) {
  const bar = "█".repeat(Math.round(result.score / 5)) + "░".repeat(20 - Math.round(result.score / 5));
  console.log(`\n[${result.grade}] ${result.name} — Score: ${result.score}/100 [${bar}] → ${result.recommendation}`);
  console.log(`  Volatility zone : ${result.volatility_zone}`);
  console.log(`  Fee/TVL ratio   : ${result.raw.fee_active_tvl_ratio ?? "n/a"}`);
  console.log(`  Volume          : $${(result.raw.volume_window ?? 0).toLocaleString()}`);
  console.log(`  Organic score   : ${result.raw.organic_score ?? "n/a"}`);
  console.log(`  Holders         : ${(result.raw.holders ?? 0).toLocaleString()}`);
  console.log(`  Active in-range : ${result.raw.active_pct ?? "n/a"}%`);
  if (result.penalties.reasons.length > 0) {
    console.log(`  Penalties:`);
    result.penalties.reasons.forEach((p) => console.log(`    ⚠ ${p.reason} (-${p.penalty} pts)`));
  }
}
