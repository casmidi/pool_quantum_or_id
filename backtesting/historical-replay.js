/**
 * backtesting/historical-replay.js — Fetch historical pool snapshots for backtesting
 *
 * Pulls historical data from:
 * - Pool-memory snapshots (primary source)
 * - Meteora API historical endpoints (secondary)
 * - Jupiter Data API for price history (fallback)
 */

import { recallForPool } from "../pool-memory.js";
import { log } from "../logger.js";

const JUP_DATAPI = "https://datapi.jup.ag/v1";
const METEORA_API = "https://dlmm-api.meteora.ag";

/**
 * Build historical snapshot array for a pool.
 * @param {Object} pool — Pool object with address
 * @param {Object} [opts]
 * @param {number} [opts.maxSnapshots=100]
 * @param {number} [opts.historyHours=24]
 * @returns {Promise<Array<Object>>} Sorted snapshots
 */
export async function fetchPoolHistory(pool, opts = {}) {
  const {
    maxSnapshots = 100,
    historyHours = 24,
  } = opts;

  const poolAddress = pool.address || pool.pool_address || pool.poolAddress;
  if (!poolAddress) {
    log("backtest", "No pool address provided for history fetch");
    return [];
  }

  const snapshots = [];

  // Source 1: Pool-memory snapshots
  try {
    const memory = await recallForPool(poolAddress);
    if (memory?.snapshots && Array.isArray(memory.snapshots)) {
      const recent = memory.snapshots
        .filter(s => s.timestamp > Date.now() / 1000 - historyHours * 3600)
        .slice(-maxSnapshots);
      snapshots.push(...recent);
      log("backtest", `Loaded ${recent.length} pool-memory snapshots for ${pool.name || poolAddress.slice(0, 8)}`);
    }
  } catch (err) {
    log("backtest", `Pool-memory recall failed: ${err.message}`);
  }

  // Source 2: Meteora API — pool historical data
  if (snapshots.length < 2) {
    try {
      const url = `${METEORA_API}/pair/${poolAddress}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data?.historical_data && Array.isArray(data.historical_data)) {
          snapshots.push(...data.historical_data.slice(-maxSnapshots));
          log("backtest", `Loaded ${data.historical_data.length} Meteora historical snapshots`);
        }
      }
    } catch (err) {
      log("backtest", `Meteora API fetch failed: ${err.message}`);
    }
  }

  // Deduplicate by timestamp and sort
  const seen = new Set();
  const unique = snapshots.filter(s => {
    const key = s.timestamp ?? s.ts ?? 0;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.timestamp ?? a.ts ?? 0) - (b.timestamp ?? b.ts ?? 0));

  return unique.slice(-maxSnapshots);
}

/**
 * Inline backtest: fetch history + run simulation.
 * @param {Object} pool
 * @param {BacktestConfig} config
 * @returns {Promise<BacktestResult>}
 */
export async function inlineBacktest(pool, config) {
  const { runBacktest } = await import("./simulator.js");
  const snapshots = await fetchPoolHistory(pool, {
    maxSnapshots: config.maxSnapshots || 100,
    historyHours: config.historyHours || 24,
  });

  const enrichedPool = {
    ...pool,
    snapshots,
  };

  return runBacktest(enrichedPool, config);
}
