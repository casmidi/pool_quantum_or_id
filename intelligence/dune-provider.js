/**
 * intelligence/dune-provider.js
 * Dune Analytics connector for historical PnL & leaderboard data.
 * 
 * Graceful degradation: if no API key, returns null / empty data
 * and the fusion layer falls back to other providers.
 * 
 * Dune API v2 (requires API key):
 *   GET https://api.dune.com/api/v2/query/{query_id}/results
 */

import { rateLimitedFetch } from "./rate-limiter.js";
import { cacheWrap } from "./cache-manager.js";
import { log } from "../logger.js";

const BASE_URL = "https://api.dune.com/api/v2";
const CACHE_TTL_RESULTS = 6 * 60 * 60 * 1000; // 6 hours (historical data changes slowly)

/**
 * Check if Dune API key is configured.
 */
function hasApiKey() {
  return !!(process.env.DUNE_API_KEY);
}

function headers() {
  return {
    "Accept": "application/json",
    "x-dune-api-key": process.env.DUNE_API_KEY || "",
  };
}

/**
 * Execute a query by ID and return results.
 * @param {number|string} queryId — Dune query ID
 * @param {object} [params] — query parameters
 * @returns {Array<object>|null}
 */
export async function executeQuery(queryId, params = {}) {
  if (!hasApiKey()) {
    log("dune", "No DUNE_API_KEY configured, skipping query");
    return null;
  }

  const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  const cacheKey = `dune:q:${queryId}:${paramStr}`;

  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("dune", async () => {
        // Step 1: Execute query
        const execRes = await fetch(`${BASE_URL}/query/${queryId}/execute`, {
          method: "POST",
          headers: headers(),
          signal: AbortSignal.timeout(15_000),
        });
        if (!execRes.ok) {
          throw new Error(`Dune execute ${execRes.status}: ${await execRes.text()}`);
        }
        const { execution_id } = await execRes.json();
        if (!execution_id) throw new Error("No execution_id from Dune");

        // Step 2: Poll for results (max 30s)
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const resultRes = await fetch(`${BASE_URL}/execution/${execution_id}/results`, {
            headers: headers(),
            signal: AbortSignal.timeout(10_000),
          });
          if (resultRes.status === 200) {
            const data = await resultRes.json();
            if (data?.result?.rows) return data.result.rows;
          }
          const state = resultRes.headers?.get("x-dune-execution-state") || "PENDING";
          if (state === "FAILED") throw new Error("Dune query execution failed");
        }
        throw new Error("Dune query timed out after 30s");
      });
      return result || [];
    } catch (err) {
      log("dune", `executeQuery error: ${err.message}`);
      return [];
    }
  }, { namespace: "dune", ttlMs: CACHE_TTL_RESULTS });
}

/**
 * Fetch top LP performers from Dune leaderboard (Metetera-specific query).
 * Uses a predefined query ID for Meteora DLMM leaderboard.
 * Falls back to empty array gracefully.
 * @returns {Array<object>}
 */
export async function fetchTopLpLeaderboard() {
  const DUNE_METEORA_LEADERBOARD_QUERY = process.env.DUNE_METEORA_QUERY_ID || "4382919";
  const results = await executeQuery(DUNE_METEORA_LEADERBOARD_QUERY);
  if (!results) return [];
  
  return results.map((row) => ({
    address: row.wallet_address || row.address || row.wallet,
    label: row.label || row.name || null,
    pnlUsd: parseFloat(row.pnl_usd || row.pnl || 0),
    roiPct: parseFloat(row.roi_pct || row.roi || 0),
    trades: parseInt(row.trades || row.trade_count || 0, 10),
    winRate: parseFloat(row.win_rate || row.winrate || 0),
    volumeUsd: parseFloat(row.volume_usd || row.volume || 0),
    source: "dune",
  }));
}

/**
 * Fetch historical PnL for a specific wallet from Dune.
 * @param {string} address
 * @returns {object|null}
 */
export async function fetchWalletHistoricalPnl(address) {
  const DUNE_WALLET_PNL_QUERY = process.env.DUNE_WALLET_PNL_QUERY_ID || "4382920";
  const results = await executeQuery(DUNE_WALLET_PNL_QUERY, { wallet: address });
  if (!results?.length) return null;
  
  return {
    address,
    pnl7d: parseFloat(results[0].pnl_7d || 0),
    pnl30d: parseFloat(results[0].pnl_30d || 0),
    pnlAll: parseFloat(results[0].pnl_all || 0),
    winRate: parseFloat(results[0].win_rate || 0),
    sharpeRatio: parseFloat(results[0].sharpe_ratio || 0),
    maxDrawdown: parseFloat(results[0].max_drawdown || 0),
    source: "dune",
  };
}

/**
 * Check if Dune provider is available.
 */
export function isDuneAvailable() {
  return hasApiKey();
}

export function getDuneStatus() {
  return {
    name: "Dune Analytics",
    available: isDuneAvailable(),
    hasApiKey: hasApiKey(),
    authenticated: hasApiKey(),
  };
}
