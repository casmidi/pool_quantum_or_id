/**
 * backtest.js
 * Historical backtest for Meridian DLMM LP strategy.
 *
 * Workflow:
 *   1. Fetch qualifying pools from Meteora Pool Discovery API
 *   2. Load downloaded price history from backtest/history/{mint}.json
 *      (run `node backtest/fetch-history.js` first)
 *   3. For each pool × each entry day in price history:
 *      - fee_income = deploy_amount × fee_rate_daily × holding_days × in_range_pct
 *      - IL         = standard CP-AMM IL from real entry/exit prices
 *      - net_return = fee_income - IL
 *   4. Win rate = entry_points_with_net_return>0 / total_entry_points
 *
 * If no price history available for a token, falls back to volatility-proxy simulation.
 *
 * Run:
 *   node backtest/fetch-history.js   ← download price data first
 *   node backtest/backtest.js        ← run backtest
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scorePool, rankPools, DEFAULT_WEIGHTS } from "../strategy/pool-scorer.js";
import { fetchHistory } from "./fetch-history.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const HISTORY_DIR         = path.join(__dirname, "history");
const RESULTS_DIR         = path.join(__dirname, "results");

const TIMEFRAME          = "30m";
const TIMEFRAME_MINUTES  = 30;
const PERIODS_PER_DAY    = (24 * 60) / TIMEFRAME_MINUTES; // 48

const BACKTEST_CONFIG = {
  deployAmountSol:      0.5,
  solPriceUsd:          150,
  holdingDays:          [1, 3, 7],
  topN:                 30,
  minScore:             35,

  // Pool quality filters
  minFeeActiveTvlRatio: 0.002,
  minOrganic:           50,
  minHolders:           50,
  maxVolatility:        0.60,
  minVolatility:        0.001,
  minTvl:               3_000,

  // Simulation caps
  feeCapDailyPct:       0.50,
  ilCapTotal:           0.80,

  // History
  minHistoricalCandles: 8,     // minimum candles to use historical mode
  targetWinRate:        0.70,  // >70%
};

// ---------------------------------------------------------------------------
// Meteora API helper
// ---------------------------------------------------------------------------

async function fetchJson(url, label = url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "meridian-backtest/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${label} → HTTP ${res.status}`);
  return res.json();
}

async function fetchTopPools({ pageSize = 200 } = {}) {
  const cfg = BACKTEST_CONFIG;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "pool_type=dlmm",
    `tvl>=${cfg.minTvl}`,
    `fee_active_tvl_ratio>=${cfg.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${cfg.minOrganic}`,
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${TIMEFRAME}` +
    `&category=all`;

  console.log(`[Fetch] ${url}\n`);
  const data = await fetchJson(url, "pool-discovery");
  const pools = Array.isArray(data) ? data : (data.data ?? []);
  console.log(`[Fetch] ${pools.length} pools (total: ${data.total ?? pools.length})\n`);
  return pools;
}

// ---------------------------------------------------------------------------
// Field extraction (mirrors condensePool in screening.js)
// ---------------------------------------------------------------------------

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function condense(raw) {
  const base = raw.token_x ?? {};
  const dlmm = raw.dlmm_params ?? {};
  const createdAt = toNum(base.created_at);
  return {
    pool:                 raw.pool_address ?? raw.address,
    name:                 raw.name ?? `${base.symbol ?? "?"}/SOL`,
    mint:                 base.address,
    tvl:                  toNum(raw.tvl),
    active_tvl:           toNum(raw.active_tvl),
    fee_active_tvl_ratio: toNum(raw.fee_active_tvl_ratio),
    volume_window:        toNum(raw.volume),
    fee_window:           toNum(raw.fee),
    fee_change_pct:       toNum(raw.fee_change_pct),
    volume_change_pct:    toNum(raw.volume_change_pct),
    active_pct:           toNum(raw.active_positions_pct),
    organic_score:        toNum(base.organic_score),
    holders:              toNum(raw.base_token_holders),
    token_age_hours:      createdAt ? Math.floor((Date.now() - createdAt) / 3_600_000) : null,
    volatility:           toNum(raw.volatility),
    bin_step:             toNum(dlmm.bin_step),
    fee_pct:              toNum(raw.fee_pct) ?? toNum(dlmm.base_fee_pct) ?? 0.003,
    mcap:                 toNum(base.market_cap),
    price_trend:          raw.price_trend ?? "unknown",
    price_vs_ath_pct:     toNum(raw.price_vs_ath_pct),
    smart_money_buy:      raw.smart_money_buy === true,
    kol_in_clusters:      raw.kol_in_clusters === true,
    top_cluster_trend:    raw.top_cluster_trend ?? "",
    discord_signal:       !!raw.discord_signal,
    discord_signal_count: toNum(raw.discord_signal_count),
    bundle_pct:           toNum(raw.bundle_pct),
    sniper_pct:           toNum(raw.sniper_pct),
    dev_sold_all:         raw.dev_sold_all === true,
    is_wash:              raw.is_wash === true,
    is_pvp:               raw.is_pvp === true,
    pvp_risk:             raw.pvp_risk ?? "",
  };
}

function passesQualityFilter(pool) {
  const cfg = BACKTEST_CONFIG;
  if (!pool.pool || !pool.mint) return false;
  if (pool.is_wash || pool.dev_sold_all) return false;
  const vol = pool.volatility;
  if (vol == null || vol <= 0) return false;
  if (vol > cfg.maxVolatility || vol < cfg.minVolatility) return false;
  if ((pool.fee_active_tvl_ratio ?? 0) < cfg.minFeeActiveTvlRatio) return false;
  if ((pool.tvl ?? 0) < cfg.minTvl) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Price history loader
// ---------------------------------------------------------------------------

function loadPriceHistory(mint) {
  const file = path.join(HISTORY_DIR, `${mint}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IL calculation (standard constant-product AMM)
//
// r = exitPrice / entryPrice
// IL = 2*sqrt(r)/(1+r) - 1  (always negative or zero → take abs)
//
// DLMM adjustments:
//   inRange:    only in-range liquidity suffers IL
//   binDamping: wider bins → price stays in range longer → lower effective IL
// ---------------------------------------------------------------------------

function calcIL(entryPrice, exitPrice, binStep, activePct) {
  if (entryPrice <= 0 || exitPrice <= 0) return 0;
  const r          = exitPrice / entryPrice;
  const ilRaw      = Math.abs(2 * Math.sqrt(r) / (1 + r) - 1);
  const inRange    = Math.min(1, Math.max(0.2, (activePct ?? 70) / 100));
  const binDamping = Math.max(0.3, 1 - (binStep ?? 100) / 10_000 * 0.5);
  return Math.min(ilRaw * inRange * binDamping, BACKTEST_CONFIG.ilCapTotal);
}

// Volatility-proxy version (fallback when no price history)
function calcILFromVolatility(pool, holdingDays) {
  const volPeriod = pool.volatility ?? 0.04;
  const volDaily  = volPeriod * Math.sqrt(PERIODS_PER_DAY);
  const priceMove = volDaily * Math.sqrt(holdingDays);
  return calcIL(1, 1 + priceMove, pool.bin_step, pool.active_pct);
}

// ---------------------------------------------------------------------------
// Daily fee income estimate
// fee_active_tvl_ratio is per 30m window → scale by periods_per_day
// ---------------------------------------------------------------------------

function dailyFeeIncome(pool, deployAmountUsd) {
  const ratioPerPeriod = pool.fee_active_tvl_ratio ?? 0;
  const ratioDaily     = ratioPerPeriod * PERIODS_PER_DAY;
  const inRange        = Math.min(1, Math.max(0.2, (pool.active_pct ?? 70) / 100));
  const raw            = deployAmountUsd * ratioDaily * inRange;
  return Math.min(raw, deployAmountUsd * BACKTEST_CONFIG.feeCapDailyPct);
}

// ---------------------------------------------------------------------------
// Simulate using real historical price data
// Tests EVERY possible entry day: deploy on day[i], exit on day[i+N]
// ---------------------------------------------------------------------------

function simulateHistorical(pool, deployAmountUsd, candles) {
  const cfg = BACKTEST_CONFIG;
  const feePerDay = dailyFeeIncome(pool, deployAmountUsd);
  const simulations = {};

  for (const days of cfg.holdingDays) {
    const entryPoints = [];

    for (let i = 0; i <= candles.length - days - 1; i++) {
      const entryPrice = candles[i].close ?? candles[i].open;
      const exitPrice  = candles[i + days].close ?? candles[i + days].open;

      if (!entryPrice || !exitPrice) continue;

      const feeIncome   = feePerDay * days;
      const ilFraction  = calcIL(entryPrice, exitPrice, pool.bin_step, pool.active_pct);
      const ilLoss      = ilFraction * deployAmountUsd;
      const netReturn   = feeIncome - ilLoss;
      const priceChange = (exitPrice - entryPrice) / entryPrice;

      entryPoints.push({
        entry_day:      candles[i].date,
        exit_day:       candles[i + days]?.date,
        entry_price:    entryPrice,
        exit_price:     exitPrice,
        price_change:   Math.round(priceChange * 10000) / 10000,
        fee_income_usd: Math.round(feeIncome * 100) / 100,
        il_loss_usd:    Math.round(ilLoss * 100) / 100,
        il_pct:         Math.round(ilFraction * 10000) / 10000,
        net_return_usd: Math.round(netReturn * 100) / 100,
        net_return_pct: Math.round(netReturn / deployAmountUsd * 10000) / 10000,
        profitable:     netReturn > 0,
      });
    }

    if (entryPoints.length === 0) {
      simulations[`${days}d`] = { mode: "no_data", entry_points: 0, win_rate: null };
      continue;
    }

    const profitable = entryPoints.filter((e) => e.profitable).length;
    const winRate    = profitable / entryPoints.length;
    const avgNet     = entryPoints.reduce((s, e) => s + e.net_return_pct, 0) / entryPoints.length;
    const bestEntry  = [...entryPoints].sort((a, b) => b.net_return_pct - a.net_return_pct)[0];
    const worstEntry = [...entryPoints].sort((a, b) => a.net_return_pct - b.net_return_pct)[0];

    simulations[`${days}d`] = {
      mode:            "historical",
      entry_points:    entryPoints.length,
      profitable:      profitable,
      win_rate:        Math.round(winRate * 1000) / 1000,
      win_rate_pct:    Math.round(winRate * 1000) / 10,
      avg_net_pct:     Math.round(avgNet * 10000) / 10000,
      avg_fee_usd:     Math.round(feePerDay * days * 100) / 100,
      best: {
        entry_day:  bestEntry.entry_day,
        net_pct:    bestEntry.net_return_pct,
      },
      worst: {
        entry_day:  worstEntry.entry_day,
        net_pct:    worstEntry.net_return_pct,
      },
      sample: entryPoints.slice(-5), // last 5 entry points for inspection
    };
  }

  return simulations;
}

// ---------------------------------------------------------------------------
// Fallback: volatility-proxy simulation (single point, not historical)
// ---------------------------------------------------------------------------

function simulateProxy(pool, deployAmountUsd) {
  const feePerDay = dailyFeeIncome(pool, deployAmountUsd);
  const simulations = {};

  for (const days of BACKTEST_CONFIG.holdingDays) {
    const feeIncome  = feePerDay * days;
    const ilFraction = calcILFromVolatility(pool, days);
    const ilLoss     = ilFraction * deployAmountUsd;
    const netReturn  = feeIncome - ilLoss;

    const volDaily  = (pool.volatility ?? 0.04) * Math.sqrt(PERIODS_PER_DAY);
    const priceMove = volDaily * Math.sqrt(days);

    simulations[`${days}d`] = {
      mode:            "volatility_proxy",
      entry_points:    1,
      profitable:      netReturn > 0,
      win_rate:        netReturn > 0 ? 1 : 0,
      win_rate_pct:    netReturn > 0 ? 100 : 0,
      avg_net_pct:     Math.round(netReturn / deployAmountUsd * 10000) / 10000,
      fee_income_usd:  Math.round(feeIncome * 100) / 100,
      il_loss_usd:     Math.round(ilLoss * 100) / 100,
      price_move_pct:  Math.round(priceMove * 10000) / 10000,
    };
  }

  return simulations;
}

// ---------------------------------------------------------------------------
// Aggregate win rate across all pools & entry points
// ---------------------------------------------------------------------------

function aggregateWinRate(results, holdingDays) {
  const agg = {};
  for (const days of holdingDays) {
    const key = `${days}d`;
    let totalEntries = 0, totalProfitable = 0;
    for (const r of results) {
      const s = r.simulations?.[key];
      if (!s || s.win_rate == null) continue;
      totalEntries   += s.entry_points;
      totalProfitable += (s.win_rate ?? 0) * s.entry_points;
    }
    agg[key] = {
      total_entries:    totalEntries,
      profitable_entries: Math.round(totalProfitable),
      win_rate:         totalEntries > 0 ? totalProfitable / totalEntries : 0,
      win_rate_pct:     totalEntries > 0 ? Math.round(totalProfitable / totalEntries * 1000) / 10 : 0,
    };
  }
  return agg;
}

// ---------------------------------------------------------------------------
// Main backtest runner
// ---------------------------------------------------------------------------

export async function runBacktest(options = {}) {
  const cfg        = { ...BACKTEST_CONFIG, ...options };
  const deployUsd  = cfg.deployAmountSol * cfg.solPriceUsd;

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║  Meridian DLMM Historical Backtest v2    ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`  Deploy        : ${cfg.deployAmountSol} SOL ≈ $${deployUsd}`);
  console.log(`  Timeframe     : ${TIMEFRAME} (${PERIODS_PER_DAY} periods/day)`);
  console.log(`  Holding       : ${cfg.holdingDays.join(", ")} days`);
  console.log(`  Target win%   : >${cfg.targetWinRate * 100}%\n`);

  // 1. Download price history if not present
  if (!fs.existsSync(HISTORY_DIR) || fs.readdirSync(HISTORY_DIR).length === 0) {
    console.log("  No history data found. Downloading now...\n");
    await fetchHistory({ force: false });
  } else {
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
    console.log(`  Price history : ${files.length} tokens cached in ${HISTORY_DIR}`);
    const oldest = files.map((f) => fs.statSync(path.join(HISTORY_DIR, f)).mtimeMs).sort()[0];
    const ageH   = (Date.now() - oldest) / 3_600_000;
    if (ageH > 24) {
      console.log(`  ⚠  Oldest cache is ${ageH.toFixed(0)}h old. Run fetch-history.js --force to refresh.\n`);
    } else {
      console.log(`  Cache age     : ${ageH.toFixed(1)}h (fresh)\n`);
    }
  }

  // 2. Fetch qualifying pools
  let rawPools;
  try {
    rawPools = await fetchTopPools({ pageSize: 200 });
  } catch (e) {
    console.error(`[Error] ${e.message}`); process.exit(1);
  }

  const allCondensed = rawPools.map(condense);
  const filtered     = allCondensed.filter(passesQualityFilter);
  console.log(`Condensed: ${allCondensed.length} → quality filter: ${filtered.length} pools\n`);

  // 3. Score and rank
  const scored = rankPools(filtered, DEFAULT_WEIGHTS)
    .filter((r) => r.score >= cfg.minScore)
    .slice(0, cfg.topN);

  if (scored.length === 0) {
    console.log("No qualifying pools. Lower minScore or relax quality filters.");
    return null;
  }

  console.log(`Scored: ${scored.length} qualify (score ≥ ${cfg.minScore})\n`);

  // 4. Simulate each pool
  let historicalCount = 0, proxyCount = 0;
  const results = [];

  for (const scoredPool of scored) {
    const pool    = filtered.find((p) => p.pool === scoredPool.pool);
    const history = pool?.mint ? loadPriceHistory(pool.mint) : null;
    const candles = history?.candles;

    let simulations;
    let mode;

    if (candles && candles.length >= cfg.minHistoricalCandles) {
      simulations = simulateHistorical(pool, deployUsd, candles);
      mode = "historical";
      historicalCount++;
    } else {
      simulations = simulateProxy(pool, deployUsd);
      mode = "volatility_proxy";
      proxyCount++;
    }

    const sim1d = simulations["1d"];
    const sim7d = simulations["7d"];

    results.push({
      rank:            results.length + 1,
      pool:            scoredPool.pool,
      name:            scoredPool.name,
      mint:            pool?.mint,
      score:           scoredPool.score,
      grade:           scoredPool.grade,
      recommendation:  scoredPool.recommendation,
      volatility_zone: scoredPool.volatility_zone,
      mode,
      history_source:  history?.source ?? "none",
      candle_count:    candles?.length ?? 0,
      pool_metrics: {
        fee_active_tvl_ratio: pool?.fee_active_tvl_ratio,
        fee_ratio_daily:      Math.round((pool?.fee_active_tvl_ratio ?? 0) * PERIODS_PER_DAY * 10000) / 10000,
        volatility:           pool?.volatility,
        active_pct:           pool?.active_pct,
        bin_step:             pool?.bin_step,
        tvl:                  pool?.tvl,
        holders:              pool?.holders,
        organic_score:        pool?.organic_score,
      },
      simulations,
      win_rate_1d:    sim1d?.win_rate_pct,
      win_rate_7d:    sim7d?.win_rate_pct,
      avg_net_1d_pct: sim1d?.avg_net_pct,
      avg_net_7d_pct: sim7d?.avg_net_pct,
    });
  }

  // 5. Aggregate stats
  const agg      = aggregateWinRate(results, cfg.holdingDays);
  const agg1d    = agg["1d"];
  const agg7d    = agg["7d"];

  // Pool-level: how many pools have win_rate > target
  const poolsAboveTarget1d = results.filter((r) => (r.win_rate_1d ?? 0) >= cfg.targetWinRate * 100).length;
  const poolsAboveTarget7d = results.filter((r) => (r.win_rate_7d ?? 0) >= cfg.targetWinRate * 100).length;

  const summary = {
    run_at:           new Date().toISOString(),
    deploy_sol:       cfg.deployAmountSol,
    deploy_usd:       deployUsd,
    total_fetched:    rawPools.length,
    quality_pass:     filtered.length,
    qualifying:       results.length,
    historical_mode:  historicalCount,
    proxy_mode:       proxyCount,
    aggregate_win_rate: {
      "1d": agg1d,
      "3d": agg["3d"],
      "7d": agg7d,
    },
    pools_above_target: {
      "1d": `${poolsAboveTarget1d}/${results.length}`,
      "7d": `${poolsAboveTarget7d}/${results.length}`,
    },
    target_70pct_met: {
      entries_1d: (agg1d?.win_rate ?? 0) >= cfg.targetWinRate,
      entries_7d: (agg7d?.win_rate ?? 0) >= cfg.targetWinRate,
      pools_1d:   poolsAboveTarget1d / results.length >= cfg.targetWinRate,
      pools_7d:   poolsAboveTarget7d / results.length >= cfg.targetWinRate,
    },
  };

  // 6. Write results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const ts      = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(RESULTS_DIR, `backtest_${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2), "utf8");

  // 7. Print report
  console.log("╔══════════════════════════════════════════╗");
  console.log("║          Historical Backtest Results     ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Pools tested  : ${results.length} (${historicalCount} historical, ${proxyCount} proxy)`);
  console.log(`  Total entries : ${agg1d?.total_entries ?? 0} (1d), ${agg7d?.total_entries ?? 0} (7d)`);
  console.log();
  console.log("  ── Aggregate Win Rate (all entry points) ──────────────────");
  for (const days of cfg.holdingDays) {
    const a = agg[`${days}d`];
    if (!a) continue;
    const target = a.win_rate >= cfg.targetWinRate ? "✓" : "✗";
    console.log(`  ${days}d : ${a.win_rate_pct.toFixed(1)}%  (${a.profitable_entries}/${a.total_entries} entries)  ${target}`);
  }
  console.log();
  console.log("  ── Pools with win rate > 70% ───────────────────────────────");
  console.log(`  1d : ${poolsAboveTarget1d}/${results.length} pools`);
  console.log(`  7d : ${poolsAboveTarget7d}/${results.length} pools`);
  console.log();
  console.log("  ── Target >70% met ─────────────────────────────────────────");
  const t = summary.target_70pct_met;
  console.log(`  Entry-level (1d) : ${t.entries_1d ? "✓ YES" : "✗ NO"}`);
  console.log(`  Entry-level (7d) : ${t.entries_7d ? "✓ YES" : "✗ NO"}`);
  console.log(`  Pool-level  (1d) : ${t.pools_1d  ? "✓ YES" : "✗ NO"}`);
  console.log(`  Pool-level  (7d) : ${t.pools_7d  ? "✓ YES" : "✗ NO"}`);
  console.log(`\n  Results → ${outFile}\n`);

  // 8. Per-pool summary table
  console.log("╔══════════════════════════════════════════╗");
  console.log("║             Pool Rankings                ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  ${"#".padEnd(3)} ${"Pool".padEnd(20)} ${"Gr".padEnd(3)} ${"Sc".padEnd(4)} ${"Mode".padEnd(8)} ${"Candles".padEnd(8)} ${"1d WR%".padEnd(8)} ${"7d WR%".padEnd(8)} ${"Avg1d".padEnd(8)}`);
  console.log(`  ${"─".repeat(80)}`);

  for (const r of results.slice(0, 20)) {
    const mode  = r.mode === "historical" ? "hist" : "proxy";
    const wr1d  = r.win_rate_1d  != null ? r.win_rate_1d.toFixed(1) + "%" : "—";
    const wr7d  = r.win_rate_7d  != null ? r.win_rate_7d.toFixed(1) + "%" : "—";
    const avg1d = r.avg_net_1d_pct != null ? ((r.avg_net_1d_pct ?? 0) * 100).toFixed(1) + "%" : "—";
    const flag  = (r.win_rate_1d ?? 0) >= 70 ? "✓" : "·";
    console.log(
      `  ${flag} ${String(r.rank).padEnd(2)} ${r.name.slice(0, 19).padEnd(20)} ${r.grade.padEnd(3)} ${String(r.score).padEnd(4)} ${mode.padEnd(8)} ${String(r.candle_count).padEnd(8)} ${wr1d.padEnd(8)} ${wr7d.padEnd(8)} ${avg1d}`
    );
  }

  console.log();
  return { summary, results };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    const [key, val] = arg.replace(/^--/, "").split("=");
    if (key === "sol")       options.deployAmountSol = Number(val);
    if (key === "min-score") options.minScore        = Number(val);
    if (key === "top")       options.topN            = Number(val);
  }
  runBacktest(options).catch((e) => { console.error("[Fatal]", e); process.exit(1); });
}
