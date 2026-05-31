/**
 * intelligence/gmgn-provider.js
 * GMGN.ai API wrapper — primary real-time source for wallet LP data.
 * Falls back gracefully when API key is missing or rate limited.
 * 
 * Public endpoints used when no API key:
 *   GET https://gmgn.ai/api/v1/wallet/{address}
 *   GET https://gmgn.ai/api/v1/wallet/{address}/pnl
 *   GET https://gmgn.ai/api/v1/wallet/{address}/positions
 */

import { rateLimitedFetch } from "./rate-limiter.js";
import { cacheWrap, cacheSet } from "./cache-manager.js";
import { log } from "../logger.js";

const BASE_URL = "https://gmgn.ai/api/v1";
const CACHE_TTL_L1 = 2 * 60 * 1000;   // 2 min (hot data)
const CACHE_TTL_L2 = 15 * 60 * 1000;  // 15 min (wallet profile)

/**
 * Check if GMGN API key is configured.
 */
function hasApiKey() {
  return !!(process.env.GMGN_API_KEY || process.env.GMGN_KEY);
}

function headers() {
  const h = { "Accept": "application/json" };
  const key = process.env.GMGN_API_KEY || process.env.GMGN_KEY;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

/**
 * Fetch wallet overview from GMGN.
 * @param {string} address — Solana wallet address
 * @returns {object|null} wallet data
 */
export async function fetchWalletProfile(address) {
  const cacheKey = `gmgn:wallet:${address}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("gmgn", async () => {
        const url = `${BASE_URL}/wallet/${address}`;
        const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          if (res.status === 404) return null;
          throw new Error(`GMGN wallet ${res.status}: ${await res.text().catch(() => "")}`);
        }
        return res.json();
      });
      return result?.data || result || null;
    } catch (err) {
      log("gmgn", `fetchWalletProfile error [${address.slice(0, 8)}]: ${err.message}`);
      return null;
    }
  }, { namespace: "gmgn", ttlMs: CACHE_TTL_L2 });
}

/**
 * Fetch wallet PnL history (7d / 30d / all-time).
 * @param {string} address
 * @param {string} period — "7d" | "30d" | "all"
 * @returns {object|null}
 */
export async function fetchWalletPnl(address, period = "30d") {
  const cacheKey = `gmgn:pnl:${address}:${period}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("gmgn", async () => {
        const url = `${BASE_URL}/wallet/${address}/pnl?period=${period}`;
        const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        return res.json();
      });
      return result?.data || result || null;
    } catch (err) {
      log("gmgn", `fetchWalletPnl error [${address.slice(0, 8)}]: ${err.message}`);
      return null;
    }
  }, { namespace: "gmgn", ttlMs: CACHE_TTL_L1 });
}

/**
 * Fetch wallet open positions.
 * @param {string} address
 * @returns {Array<object>}
 */
export async function fetchWalletPositions(address) {
  const cacheKey = `gmgn:positions:${address}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("gmgn", async () => {
        const url = `${BASE_URL}/wallet/${address}/positions`;
        const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        return res.json();
      });
      return result?.data || result?.positions || [];
    } catch (err) {
      log("gmgn", `fetchWalletPositions error [${address.slice(0, 8)}]: ${err.message}`);
      return [];
    }
  }, { namespace: "gmgn", ttlMs: CACHE_TTL_L1 });
}

/**
 * Fetch wallet's token holdings with metadata.
 * @param {string} address
 * @returns {Array<object>}
 */
export async function fetchWalletTokens(address) {
  const cacheKey = `gmgn:tokens:${address}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("gmgn", async () => {
        const url = `${BASE_URL}/wallet/${address}/tokens`;
        const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        return res.json();
      });
      return result?.data || result?.tokens || [];
    } catch (err) {
      log("gmgn", `fetchWalletTokens error [${address.slice(0, 8)}]: ${err.message}`);
      return [];
    }
  }, { namespace: "gmgn", ttlMs: CACHE_TTL_L2 });
}

/**
 * Comprehensive wallet data fetch — aggregates all endpoints.
 * @param {string} address
 * @returns {object} aggregated wallet data
 */
export async function fetchWalletComprehensive(address) {
  const [profile, pnl7d, pnl30d, pnlAll, positions, tokens] = await Promise.all([
    fetchWalletProfile(address),
    fetchWalletPnl(address, "7d"),
    fetchWalletPnl(address, "30d"),
    fetchWalletPnl(address, "all"),
    fetchWalletPositions(address),
    fetchWalletTokens(address),
  ]);

  return {
    address,
    profile,
    pnl: { "7d": pnl7d, "30d": pnl30d, all: pnlAll },
    positions,
    tokens,
    fetchedAt: Date.now(),
  };
}

/**
 * Check if GMGN provider is available (API key present or public endpoints work).
 */
export function isGmgnAvailable() {
  return hasApiKey() || true; // public endpoints available even without key
}

/**
 * Get provider status.
 */
export function getGmgnStatus() {
  return {
    name: "GMGN.ai",
    available: isGmgnAvailable(),
    hasApiKey: hasApiKey(),
    authenticated: hasApiKey(),
  };
}
