/**
 * fetch-history.js
 * Downloads 30-day daily OHLCV for each Solana token in qualifying pools.
 * Saves to backtest/history/{mint}.json for use by backtest.js.
 *
 * Data sources (tried in order):
 *   1. GeckoTerminal /networks/solana/pools/{poolAddr}/ohlcv/day  (free, pool address, OHLCV)
 *   2. CoinGecko /coins/solana/contract/{mint}/market_chart        (free, close price only)
 *
 * GeckoTerminal is preferred: works with pool addresses, no coin ID mapping needed,
 * and has real OHLCV (open/high/low/close) for accurate IL simulation.
 *
 * Run: node backtest/fetch-history.js
 *      node backtest/fetch-history.js --force   (re-download even if cached)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const GECKO_TERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const COINGECKO_BASE      = "https://api.coingecko.com/api/v3";
const HISTORY_DIR         = path.join(__dirname, "history");
const DAYS                = 30;
const CACHE_MAX_AGE_H     = 6;

// GeckoTerminal: 30 req/min free → 2s delay is safe
const GT_DELAY_MS = 2200;
// CoinGecko fallback: 10-30 req/min → 6s delay
const CG_DELAY_MS = 6000;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchJson(url, headers = {}, label = "") {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "meridian-backtest/1.0",
      ...headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${label || url}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Source 1: GeckoTerminal (primary — uses pool address, full OHLCV)
// https://api.geckoterminal.com/api/v2/networks/solana/pools/{addr}/ohlcv/day?limit=30
// Response: { data: { attributes: { ohlcv_list: [[ts, o, h, l, c, vol], ...] } } }
// ---------------------------------------------------------------------------

async function fetchGeckoTerminal(poolAddress) {
  await sleep(GT_DELAY_MS);
  const url = `${GECKO_TERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/day?limit=${DAYS}`;
  const data = await fetchJson(url, {}, `gt/${poolAddress.slice(0, 8)}`);

  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.length < 4) throw new Error("too few candles from GeckoTerminal");

  return list.map(([ts, o, h, l, c, vol]) => ({
    date:   new Date(ts * 1000).toISOString().slice(0, 10),
    open:   Number(o),
    high:   Number(h),
    low:    Number(l),
    close:  Number(c),
    volume: Number(vol),
    ts:     Number(ts),
  })).filter((c) => c.close > 0);
}

// ---------------------------------------------------------------------------
// Source 2: CoinGecko (fallback — close price only, uses mint address)
// ---------------------------------------------------------------------------

async function fetchCoinGecko(mintAddress) {
  await sleep(CG_DELAY_MS);
  const url = `${COINGECKO_BASE}/coins/solana/contract/${mintAddress}/market_chart` +
              `?vs_currency=usd&days=${DAYS}&interval=daily`;
  const data = await fetchJson(url, {}, `cg/${mintAddress.slice(0, 8)}`);

  const prices = data?.prices ?? [];
  if (prices.length < 4) throw new Error("too few prices from CoinGecko");

  return prices.map(([ts, p]) => ({
    date:   new Date(ts).toISOString().slice(0, 10),
    open:   Number(p),
    high:   Number(p),
    low:    Number(p),
    close:  Number(p),
    volume: 0,
    ts:     Math.floor(ts / 1000),
  })).filter((c) => c.close > 0);
}

// ---------------------------------------------------------------------------
// Fetch qualifying pools from Meteora
// ---------------------------------------------------------------------------

async function fetchQualifyingPools() {
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "pool_type=dlmm",
    "tvl>=3000",
    "fee_active_tvl_ratio>=0.002",
    "base_token_organic_score>=50",
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=200` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=30m` +
    `&category=all`;

  const data = await fetchJson(url, {}, "pool-discovery");
  const pools = Array.isArray(data) ? data : (data.data ?? []);

  // Deduplicate by base token mint
  const seen = new Set();
  const unique = [];
  for (const p of pools) {
    const mint = p.token_x?.address;
    const pool = p.pool_address;
    if (!mint || !pool || seen.has(mint)) continue;
    seen.add(mint);
    unique.push({ pool, mint, symbol: p.token_x?.symbol ?? "?", name: p.name ?? "?" });
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Sort & deduplicate candles
// ---------------------------------------------------------------------------

function cleanCandles(candles) {
  candles.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return candles.filter((c) => {
    if (seen.has(c.date)) return false;
    seen.add(c.date);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main download loop
// ---------------------------------------------------------------------------

export async function fetchHistory(options = {}) {
  const force = options.force ?? false;

  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   Meridian Historical Price Downloader   ║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log("  Source priority: GeckoTerminal → CoinGecko\n");
  console.log("  Fetching pool list from Meteora...");

  let tokens;
  try {
    tokens = await fetchQualifyingPools();
  } catch (e) {
    console.error(`[Error] Cannot fetch pools: ${e.message}`);
    process.exit(1);
  }

  console.log(`  ${tokens.length} unique tokens to download\n`);

  const results = { success: [], failed: [], cached: [] };

  for (let i = 0; i < tokens.length; i++) {
    const { pool, mint, symbol } = tokens[i];
    const outFile = path.join(HISTORY_DIR, `${mint}.json`);
    const label   = `[${String(i + 1).padStart(3)}/${tokens.length}] ${symbol.padEnd(14)} ${mint.slice(0, 8)}…`;

    // Skip recent cache
    if (!force && fs.existsSync(outFile)) {
      try {
        const stat    = fs.statSync(outFile);
        const ageH    = (Date.now() - stat.mtimeMs) / 3_600_000;
        if (ageH < CACHE_MAX_AGE_H) {
          const cached = JSON.parse(fs.readFileSync(outFile, "utf8"));
          const n      = cached.candles?.length ?? 0;
          console.log(`  ${label}  ✓ cached  ${String(n).padStart(2)} candles  ${ageH.toFixed(1)}h ago`);
          results.cached.push(mint);
          continue;
        }
      } catch { /* ignore, re-download */ }
    }

    process.stdout.write(`  ${label}  `);

    let candles = null;
    let source  = null;
    const errors = [];

    // 1. GeckoTerminal (pool address → full OHLCV)
    try {
      candles = await fetchGeckoTerminal(pool);
      source  = "geckoterminal";
    } catch (e1) {
      errors.push(`gt:${e1.message.slice(0, 25)}`);

      // 2. CoinGecko (mint address → close price)
      try {
        candles = await fetchCoinGecko(mint);
        source  = "coingecko";
      } catch (e2) {
        errors.push(`cg:${e2.message.slice(0, 25)}`);
        console.log(`✗  (${errors.join(" | ")})`);
        results.failed.push({ mint, symbol, reason: errors.join(" | ") });
        continue;
      }
    }

    const clean = cleanCandles(candles);
    const out = {
      mint,
      symbol,
      pool,
      source,
      fetched_at: new Date().toISOString(),
      days:       DAYS,
      candles:    clean,
    };

    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
    console.log(`✓  ${String(clean.length).padStart(2)} candles  [${source}]`);
    results.success.push(mint);
  }

  // Summary
  const total = results.success.length + results.cached.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Downloaded  : ${results.success.length}`);
  console.log(`  Cached      : ${results.cached.length}`);
  console.log(`  Total usable: ${total}  /  ${tokens.length}`);
  console.log(`  Failed      : ${results.failed.length}`);
  if (results.failed.length > 0) {
    console.log(`  Failed tokens (will use volatility proxy in backtest):`);
    results.failed.slice(0, 10).forEach((f) => console.log(`    ✗ ${f.symbol}  ${f.reason}`));
    if (results.failed.length > 10) console.log(`    … and ${results.failed.length - 10} more`);
  }
  console.log(`  History dir : ${HISTORY_DIR}\n`);

  return results;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const force = process.argv.includes("--force");
  fetchHistory({ force }).catch((e) => { console.error("[Fatal]", e); process.exit(1); });
}
