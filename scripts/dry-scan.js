/**
 * dry-scan.js
 * Standalone dry scan — fetches live Meteora DLMM pools, scores them with
 * the full pool-scorer engine (+ Darwin weights), and simulates how a
 * given SOL wallet would be deployed.
 *
 * Run:
 *   node scripts/dry-scan.js              # 1000 SOL wallet
 *   node scripts/dry-scan.js --sol 500    # custom wallet size
 *   node scripts/dry-scan.js --sol 1000 --top 20   # show top 20 pools
 *
 * No LLM, no wallet key, no bot running required.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { scorePool, applyDarwinWeights, DEFAULT_WEIGHTS, DEFAULT_PENALTY_CONFIG } from "../strategy/pool-scorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const WALLET_SOL    = Number(argVal("--sol")  ?? 1000);
const TOP_N         = Number(argVal("--top")  ?? 15);
const SOL_PRICE_USD = Number(argVal("--price") ?? 150);
const WALLET_USD    = WALLET_SOL * SOL_PRICE_USD;

// ---------------------------------------------------------------------------
// Deployment model
// ---------------------------------------------------------------------------

const DEPLOY_CONFIG = {
  maxPositions:    15,    // max simultaneous open positions
  pctPerPool:      0.04,  // deploy 4% of wallet per A/B grade pool
  pctPerPoolC:     0.02,  // 2% for C-grade pools
  minDeployUsd:    300,   // never deploy less than $300
  maxDeployUsd:    20_000,// cap single position at $20k
  gradeFilter:     ["A", "B", "C"],  // grades allowed to deploy into
  minScore:        40,    // hard minimum score
};

// ---------------------------------------------------------------------------
// Pool Discovery API
// ---------------------------------------------------------------------------

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

const FILTERS = [
  "base_token_has_critical_warnings=false",
  "quote_token_has_critical_warnings=false",
  "pool_type=dlmm",
  "tvl>=3000",
  "fee_active_tvl_ratio>=0.002",
  "base_token_organic_score>=50",
].join("&&");

async function fetchPools(pageSize = 200) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(FILTERS)}` +
    `&timeframe=30m` +
    `&category=all`;

  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "meridian-dry-scan/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Pool discovery HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data ?? []);
}

// ---------------------------------------------------------------------------
// Map raw pool → pool-scorer compatible object
// ---------------------------------------------------------------------------

function condense(p) {
  const base = p.token_x || {};
  return {
    pool:               p.pool_address,
    name:               p.name,
    base:               { symbol: base.symbol, mint: base.address },
    quote:              { symbol: p.token_y?.symbol },
    bin_step:           p.dlmm_params?.bin_step ?? null,
    fee_pct:            p.fee_pct,
    tvl:                Number(p.tvl ?? 0),
    active_tvl:         Number(p.active_tvl ?? 0),
    fee_active_tvl_ratio: Number(p.fee_active_tvl_ratio ?? 0),
    volume_window:      Number(p.volume ?? 0),
    fee_change_pct:     Number(p.fee_change_pct ?? 0),
    volume_change_pct:  Number(p.volume_change_pct ?? 0),
    active_pct:         Number(p.active_positions_pct ?? 70),
    organic_score:      Number(base.organic_score ?? 0),
    holders:            Number(p.base_token_holders ?? 0),
    token_age_hours:    base.created_at
      ? Math.floor((Date.now() - Number(base.created_at)) / 3_600_000)
      : null,
    volatility:         Number(p.volatility ?? 0),
    mcap:               Number(base.market_cap ?? 0),
    price_trend:        p.price_trend ?? "unknown",
    discord_signal:     Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count ?? 0,
    // OKX fields — not available in dry-scan, leave null (scored neutrally)
    smart_money_buy:    null,
    kol_in_clusters:    null,
    dev_sold_all:       false,
    is_wash:            false,
    is_pvp:             false,
    bundle_pct:         null,
    sniper_pct:         null,
    price_vs_ath_pct:   null,
  };
}

// ---------------------------------------------------------------------------
// Load Darwin weights from signal-weights.json (if available)
// ---------------------------------------------------------------------------

function loadDarwinWeights() {
  const swPath = path.join(__dirname, "..", "signal-weights.json");
  if (!fs.existsSync(swPath)) return {};
  try {
    const sw = JSON.parse(fs.readFileSync(swPath, "utf8")).weights ?? {};
    return {
      fee_yield_signal:   sw.fee_tvl_ratio         ?? 1.0,
      volume_signal:      sw.volume                ?? 1.0,
      organic_signal:     sw.organic_score         ?? 1.0,
      holder_signal:      sw.holder_count          ?? 1.0,
      smart_money_signal: sw.smart_wallets_present ?? 1.0,
    };
  } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Deployment calculator
// ---------------------------------------------------------------------------

function calcDeployAmount(grade, walletUsd, cfg) {
  const pct = (grade === "A" || grade === "B") ? cfg.pctPerPool : cfg.pctPerPoolC;
  const raw = walletUsd * pct;
  return Math.max(cfg.minDeployUsd, Math.min(cfg.maxDeployUsd, raw));
}

/**
 * Return your estimated fee for ONE 30-minute period (snapshot rate).
 * This is the most honest metric — the user can decide what daily rate to expect.
 */
function feePerPeriod(pool, deployUsd) {
  const inRange   = Math.min(1, Math.max(0.3, (pool.active_pct ?? 70) / 100));
  const activeTvl = Math.max(Number(pool.active_tvl) || Number(pool.tvl) || 1, 1);
  const poolFeeThisPeriod = activeTvl * pool.fee_active_tvl_ratio * inRange;
  const yourShare = deployUsd / (activeTvl + deployUsd);
  return poolFeeThisPeriod * yourShare;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function dryScan() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║           Meridian Dry Scan — Pool Ranker             ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log(`\n  Wallet  : ${WALLET_SOL.toLocaleString()} SOL  (~$${WALLET_USD.toLocaleString()} @ $${SOL_PRICE_USD}/SOL)`);
  console.log(`  Top N   : ${TOP_N} pools displayed`);
  console.log(`  Filters : fee_active_tvl_ratio ≥ 0.002 | organic ≥ 50 | TVL ≥ $3k\n`);

  // 1. Fetch live pools
  process.stdout.write("  Fetching live pools from Meteora... ");
  let rawPools;
  try {
    rawPools = await fetchPools(200);
    console.log(`${rawPools.length} pools returned`);
  } catch (e) {
    console.error(`\n  [Error] ${e.message}`);
    process.exit(1);
  }

  if (rawPools.length === 0) {
    console.log("  No pools matched filters. Check your connection.");
    process.exit(0);
  }

  // 2. Condense + score
  const darwinW = loadDarwinWeights();
  const scorerWeights = applyDarwinWeights(darwinW);
  const hasDarwin = Object.keys(darwinW).length > 0;

  console.log(`  Scoring with pool-scorer (Darwin weights: ${hasDarwin ? "loaded from signal-weights.json" : "defaults"})...\n`);

  const scored = rawPools
    .map(condense)
    .map((pool) => {
      const result = scorePool(pool, scorerWeights);
      return { ...pool, ...result };
    })
    .filter((p) =>
      p.score >= DEPLOY_CONFIG.minScore &&
      DEPLOY_CONFIG.gradeFilter.includes(p.grade) &&
      p.recommendation !== "SKIP"
    )
    .sort((a, b) => b.score - a.score);

  const displayPools = scored.slice(0, TOP_N);

  // 3. Print ranked pool table
  const BAR_WIDTH = 20;
  const GRADE_ICON = { A: "▲", B: "●", C: "◐", D: "▼" };

  console.log(`  ${"#".padEnd(3)}  ${"Pool / Pair".padEnd(24)}  ${"Score".padEnd(6)}  ${"G".padEnd(3)}  ${"Fee/TVL".padEnd(9)}  ${"TVL".padEnd(10)}  ${"Organic".padEnd(8)}  ${"Vol Zone".padEnd(10)}  Rec`);
  console.log("  " + "─".repeat(102));

  for (let i = 0; i < displayPools.length; i++) {
    const p     = displayPools[i];
    const icon  = GRADE_ICON[p.grade] ?? "?";
    const name  = (p.name ?? `${p.base?.symbol}-${p.quote?.symbol}`).slice(0, 22).padEnd(24);
    const score = String(p.score).padEnd(6);
    const grade = `${icon}${p.grade}`.padEnd(3);
    const feeTvl = String(p.fee_active_tvl_ratio?.toFixed(4) ?? "-").padEnd(9);
    const tvl   = `$${Math.round(p.tvl / 1000)}k`.padEnd(10);
    const org   = String(Math.round(Number(p.organic_score ?? 0)) || "-").padEnd(8);
    const vz    = (p.volatility_zone ?? "-").padEnd(10);
    const rec   = p.pool_recommendation ?? p.recommendation;

    console.log(`  ${String(i + 1).padStart(2)}.  ${name}  ${score}  ${grade}  ${feeTvl}  ${tvl}  ${org}  ${vz}  ${rec}`);
  }

  // 4. Deployment simulation
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  DEPLOYMENT SIMULATION  (wallet: ${WALLET_SOL} SOL = $${WALLET_USD.toLocaleString()})`);
  console.log(`${"─".repeat(60)}`);

  const deployable = scored
    .filter((p) => p.grade === "A" || p.grade === "B")
    .slice(0, DEPLOY_CONFIG.maxPositions);

  let totalDeployedUsd   = 0;
  let totalFeePerPeriod  = 0;
  let positionCount      = 0;

  console.log(`  ${"Pool".padEnd(22)}  ${"Deploy SOL".padEnd(11)}  ${"Deploy $".padEnd(10)}  ${"Share%".padEnd(8)}  Fee/30min  Fee×10 /day`);
  console.log("  " + "─".repeat(82));

  for (const pool of deployable) {
    const deployUsd  = calcDeployAmount(pool.grade, WALLET_USD, DEPLOY_CONFIG);
    const deploySol  = deployUsd / SOL_PRICE_USD;
    const fpp        = feePerPeriod(pool, deployUsd);
    const activeTvl  = Math.max(Number(pool.active_tvl) || Number(pool.tvl) || 1, 1);
    const sharePct   = (deployUsd / (activeTvl + deployUsd)) * 100;

    totalDeployedUsd  += deployUsd;
    totalFeePerPeriod += fpp;
    positionCount++;

    const sym = `[${pool.grade}${pool.score}] ${(pool.name ?? pool.base?.symbol ?? "?").slice(0, 14)}`.padEnd(22);
    console.log(
      `  ${sym}` +
      `  ${deploySol.toFixed(1).padStart(9)} SOL` +
      `  $${Math.round(deployUsd).toLocaleString().padStart(8)}` +
      `  ${sharePct.toFixed(2).padStart(6)}%` +
      `  $${fpp.toFixed(2).padStart(8)}` +
      `  $${(fpp * 10).toFixed(2).padStart(9)}`
    );
  }

  if (positionCount === 0) {
    console.log("  No A/B grade pools available for deployment.");
  }

  // 5. Summary
  const reserveUsd  = WALLET_USD - totalDeployedUsd;
  const reserveSol  = reserveUsd / SOL_PRICE_USD;
  // Project fee income at 3 activity levels (active periods per day out of 48)
  const feeAt10 = totalFeePerPeriod * 10;   // low   ~5h active
  const feeAt24 = totalFeePerPeriod * 24;   // mid   ~12h active
  const feeAt48 = totalFeePerPeriod * 48;   // high  full 24h

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  SUMMARY`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  Qualifying pools    : ${scored.length} (of ${rawPools.length} fetched)`);
  console.log(`  A/B deployable      : ${deployable.length}`);
  console.log(`  Positions opened    : ${positionCount}`);
  console.log(`  Capital deployed    : $${Math.round(totalDeployedUsd).toLocaleString()} (${(totalDeployedUsd / WALLET_USD * 100).toFixed(1)}% of wallet)`);
  console.log(`  SOL deployed        : ${(totalDeployedUsd / SOL_PRICE_USD).toFixed(1)} SOL`);
  console.log(`  Reserve (idle)      : $${Math.round(reserveUsd).toLocaleString()} (${reserveSol.toFixed(1)} SOL)`);
  console.log();
  console.log(`  Fee/30-min period   : $${totalFeePerPeriod.toFixed(2)} (your total at current snapshot)`);
  console.log(`  Est. daily @ low    : $${feeAt10.toFixed(2)}  (10 active periods — quiet market)`);
  console.log(`  Est. daily @ medium : $${feeAt24.toFixed(2)}  (24 active periods — normal)`);
  console.log(`  Est. daily @ high   : $${feeAt48.toFixed(2)}  (48 active periods — full sustained)`);
  console.log();
  console.log("  Note: Fee/period = YOUR share of pool fees in current 30-min snapshot.");
  console.log("        IL (impermanent loss) is not included. Actual results vary.");
  console.log();

  // 6. Top pool detail breakdowns
  if (displayPools.length > 0) {
    console.log(`${"─".repeat(60)}`);
    console.log(`  TOP ${Math.min(5, displayPools.length)} SCORE BREAKDOWNS`);
    console.log(`${"─".repeat(60)}`);
    for (const p of displayPools.slice(0, 5)) {
      const bar = "█".repeat(Math.round(p.score / 5)) + "░".repeat(20 - Math.round(p.score / 5));
      console.log(`\n  [${p.grade}${p.score}] ${p.name ?? p.base?.symbol}  [${bar}]`);
      console.log(`    Vol zone: ${p.volatility_zone}  | Rec: ${p.recommendation}`);
      if (p.breakdown?.signals) {
        const sigs = p.breakdown.signals;
        const sigLines = Object.entries(sigs)
          .sort(([, a], [, b]) => b - a)
          .map(([k, v]) => `${k.padEnd(22)}: ${v.toFixed(1)}`);
        console.log("    Signals:");
        sigLines.forEach((l) => console.log(`      ${l}`));
      }
      if (p.penalties?.reasons?.length > 0) {
        console.log("    Penalties:");
        p.penalties.reasons.forEach((pen) =>
          console.log(`      ⚠ ${pen.reason}  (-${pen.penalty}pts)`)
        );
      }
    }
  }

  console.log("\n");
}

dryScan().catch((e) => {
  console.error("[Fatal]", e);
  process.exit(1);
});
