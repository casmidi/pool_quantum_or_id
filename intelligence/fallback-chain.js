/**
 * intelligence/fallback-chain.js
 * Provider fallback chain: Birdeye → Dexscreener → TrackLP.
 * Each is tried in order when primary sources fail or are unavailable.
 * 
 * These are public/free APIs — no key required.
 */

import { rateLimitedFetch } from "./rate-limiter.js";
import { cacheWrap, cacheSet } from "./cache-manager.js";
import { log } from "../logger.js";

// ─── Birdeye (Public) ──────────────────────────────────────────

const BIRDEYE_BASE = "https://public-api.birdeye.so/v1";
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Fetch wallet portfolio from Birdeye public API.
 * @param {string} address
 * @returns {object|null}
 */
async function fetchBirdeyePortfolio(address) {
  const cacheKey = `birdeye:portfolio:${address}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("birdeye", async () => {
        const res = await fetch(
          `${BIRDEYE_BASE}/wallet/token_list?wallet=${address}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return null;
        return res.json();
      });
      return result?.data || null;
    } catch (err) {
      log("birdeye", `portfolio error [${address.slice(0, 8)}]: ${err.message}`);
      return null;
    }
  }, { namespace: "birdeye", ttlMs: CACHE_TTL });
}

/**
 * Fetch token overview / metadata from Birdeye.
 * @param {string} mint — token mint address
 * @returns {object|null}
 */
async function fetchBirdeyeTokenOverview(mint) {
  const cacheKey = `birdeye:token:${mint}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("birdeye", async () => {
        const res = await fetch(
          `${BIRDEYE_BASE}/public/token_overview?address=${mint}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return null;
        return res.json();
      });
      return result?.data || null;
    } catch (err) {
      log("birdeye", `token overview error [${mint.slice(0, 8)}]: ${err.message}`);
      return null;
    }
  }, { namespace: "birdeye", ttlMs: CACHE_TTL });
}

// ─── Dexscreener (Public) ──────────────────────────────────────

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";

/**
 * Search for token pairs on Dexscreener.
 * @param {string} query — token address or symbol
 * @returns {Array<object>}
 */
async function fetchDexscreenerPairs(query) {
  const cacheKey = `dexscreener:pairs:${query}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("dexscreener", async () => {
        const res = await fetch(
          `${DEXSCREENER_BASE}/search?q=${encodeURIComponent(query)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return [];
        return res.json();
      });
      return result?.pairs || [];
    } catch (err) {
      log("dexscreener", `search error [${query.slice(0, 12)}]: ${err.message}`);
      return [];
    }
  }, { namespace: "dexscreener", ttlMs: CACHE_TTL });
}

/**
 * Fetch pairs by token address.
 * @param {string} mint — token mint
 * @returns {Array<object>}
 */
async function fetchDexscreenerTokenPairs(mint) {
  const cacheKey = `dexscreener:token:${mint}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("dexscreener", async () => {
        const res = await fetch(
          `${DEXSCREENER_BASE}/tokens/${mint}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return [];
        return res.json();
      });
      return result?.pairs || [];
    } catch (err) {
      log("dexscreener", `token pairs error [${mint.slice(0, 8)}]: ${err.message}`);
      return [];
    }
  }, { namespace: "dexscreener", ttlMs: CACHE_TTL });
}

// ─── TrackLP (Public) ──────────────────────────────────────────

const TRACKLP_BASE = "https://tracklp.com/api";

/**
 * Fetch wallet LP positions from TrackLP (Meteora-focused).
 * @param {string} address
 * @returns {Array<object>}
 */
async function fetchTrackLpPositions(address) {
  const cacheKey = `tracklp:positions:${address}`;
  return cacheWrap(cacheKey, async () => {
    try {
      const result = await rateLimitedFetch("tracklp", async () => {
        // TrackLP may have different endpoints; this is a common pattern
        const res = await fetch(
          `${TRACKLP_BASE}/solana/wallet/${address}/positions`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (res.status === 404) return []; // wallet not tracked
        if (!res.ok) return null;
        return res.json();
      });
      return result?.positions || result?.data || [];
    } catch (err) {
      log("tracklp", `positions error [${address.slice(0, 8)}]: ${err.message}`);
      return null; // null = provider failed
    }
  }, { namespace: "tracklp", ttlMs: CACHE_TTL });
}

// ─── Fallback Chain ────────────────────────────────────────────

/**
 * Available fallback providers with their priority order.
 * Each has a fetch function and a priority (lower = tried first).
 */
const FALLBACK_PROVIDERS = [
  { name: "birdeye",     priority: 1, fetchPortfolio: fetchBirdeyePortfolio, available: true },
  { name: "dexscreener", priority: 2, fetchPairs: fetchDexscreenerPairs,    available: true },
  { name: "tracklp",     priority: 3, fetchPositions: fetchTrackLpPositions, available: true },
];

/**
 * Try to fetch data from fallback providers in priority order.
 * Returns first successful result.
 * 
 * @param {string} dataType — type of data ("portfolio" | "positions" | "token-info")
 * @param {string} identifier — wallet address or token mint
 * @returns {Promise<{provider: string, data: any}|null>}
 */
export async function fallbackFetch(dataType, identifier) {
  const providers = [...FALLBACK_PROVIDERS].sort((a, b) => a.priority - b.priority);

  // Filter providers by data type capability
  const relevant = providers.filter((p) => {
    switch (dataType) {
      case "portfolio": return typeof p.fetchPortfolio === "function";
      case "positions": return typeof p.fetchPositions === "function";
      case "token-info": return typeof p.fetchPairs === "function";
      default: return false;
    }
  });

  for (const provider of relevant) {
    try {
      let data = null;
      switch (dataType) {
        case "portfolio":
          data = await provider.fetchPortfolio(identifier);
          break;
        case "positions":
          data = await provider.fetchPositions(identifier);
          break;
        case "token-info":
          data = await provider.fetchPairs(identifier);
          break;
      }

      if (data != null && (Array.isArray(data) ? data.length > 0 : true)) {
        log("fallback", `[${provider.name}] returned ${dataType} for ${identifier.slice(0, 8)}`);
        return { provider: provider.name, data };
      }
    } catch (err) {
      log("fallback", `[${provider.name}] failed for ${dataType}: ${err.message}`);
      continue;
    }
  }

  log("fallback", `All fallbacks exhausted for ${dataType}:${identifier.slice(0, 8)}`);
  return null;
}

/**
 * Fetch wallet portfolio via fallback chain.
 * @param {string} address
 * @returns {Promise<{provider: string, data: any}|null>}
 */
export async function fallbackWalletPortfolio(address) {
  return fallbackFetch("portfolio", address);
}

/**
 * Fetch wallet positions via fallback chain.
 * @param {string} address
 * @returns {Promise<{provider: string, data: any}|null>}
 */
export async function fallbackWalletPositions(address) {
  return fallbackFetch("positions", address);
}

/**
 * Fetch token info via fallback chain.
 * @param {string} mint — token mint address
 * @returns {Promise<{provider: string, data: any}|null>}
 */
export async function fallbackTokenInfo(mint) {
  return fallbackFetch("token-info", mint);
}

/**
 * Get status of all fallback providers.
 */
export function getFallbackStatus() {
  return {
    name: "Fallback Chain",
    providers: FALLBACK_PROVIDERS.map((p) => ({
      name: p.name,
      priority: p.priority,
      available: p.available,
      authenticated: false, // public APIs
    })),
  };
}
