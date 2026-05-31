/**
 * intelligence/fusion-layer.js
 * Main orchestrator — aggregates wallet data from all available providers.
 * 
 * Data flow:
 *   GMGN (primary) → Helius (txn history) → Dune (historical PnL) → Fallback chain
 * 
 * Fusion strategy:
 *   - Each provider runs in parallel (Promise.allSettled)
 *   - Best available data wins per field
 *   - Missing fields filled by next available provider
 *   - Final output is normalized, scored-ready object
 */

import { log } from "../logger.js";
import { cacheWrap, cacheSet, cacheGet } from "./cache-manager.js";
import {
  fetchWalletComprehensive as gmgnWalletComprehensive,
  isGmgnAvailable,
  getGmgnStatus,
} from "./gmgn-provider.js";
import {
  fetchWalletHistoricalPnl as duneWalletHistoricalPnl,
  fetchTopLpLeaderboard as duneLeaderboard,
  isDuneAvailable,
  getDuneStatus,
} from "./dune-provider.js";
import {
  extractLpMetrics as heliusLpMetrics,
  fetchWalletBalances as heliusBalances,
  getHeliusStatus,
} from "./helius-provider.js";
import {
  fallbackWalletPortfolio,
  fallbackWalletPositions,
  fallbackTokenInfo,
  getFallbackStatus,
} from "./fallback-chain.js";

const CACHE_TTL_WALLET = 5 * 60 * 1000;   // 5 min for full wallet data
const CACHE_TTL_TOP = 10 * 60 * 1000;     // 10 min for top wallets list

// ─── Provider Registry ─────────────────────────────────────────

const PROVIDERS = {
  gmgn: {
    name: "GMGN.ai",
    available: isGmgnAvailable,
    getStatus: getGmgnStatus,
  },
  helius: {
    name: "Helius",
    available: () => getHeliusStatus().available,
    getStatus: getHeliusStatus,
  },
  dune: {
    name: "Dune Analytics",
    available: isDuneAvailable,
    getStatus: getDuneStatus,
  },
  fallback: {
    name: "Fallback Chain",
    available: () => true,
    getStatus: getFallbackStatus,
  },
};

/**
 * Get status of all providers.
 * @returns {object}
 */
export function getProviderStatus() {
  const statuses = {};
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    statuses[key] = provider.getStatus();
  }
  return statuses;
}

/**
 * Get available providers (those with API keys or public access).
 * @returns {string[]}
 */
export function getAvailableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.available())
    .map(([key]) => key);
}

// ─── Wallet Data Fusion ────────────────────────────────────────

/**
 * Aggregate wallet data from ALL available providers.
 * Each provider runs in parallel; data is merged with priority.
 * 
 * Priority order: gmgn > helius > dune > fallback
 * 
 * @param {string} address — Solana wallet address
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false] — bypass cache
 * @returns {Promise<object>} — fused wallet data
 */
export async function fuseWalletData(address, opts = {}) {
  const cacheKey = `fused:wallet:${address}`;
  if (!opts.forceRefresh) {
    const cached = cacheGet(cacheKey, { namespace: "fusion", ttlMs: CACHE_TTL_WALLET });
    if (cached) return cached;
  }

  const startTs = Date.now();
  log("fusion", `Fusing wallet data for ${address.slice(0, 12)}...`);

  // Run all providers in parallel
  const results = await Promise.allSettled([
    gmgnWalletComprehensive(address).catch(() => null),
    heliusLpMetrics(address).catch(() => null),
    duneWalletHistoricalPnl(address).catch(() => null),
    fallbackWalletPortfolio(address).catch(() => null),
  ]);

  const [gmgnData, heliusData, duneData, fallbackPortfolio] = results.map(
    (r) => (r.status === "fulfilled" ? r.value : null)
  );

  // ── Fusion Logic ───────────────────────────────────────────
  // Merge data from all providers, preferring GMGN → Helius → Dune → Fallback

  const fused = {
    address,
    // Base info
    label: gmgnData?.profile?.label || null,
    type: classifyWalletType(gmgnData, heliusData),
    confidence: calculateConfidence([gmgnData, heliusData, duneData, fallbackPortfolio]),

    // PnL data (prefer GMGN, fill gaps from Dune)
    pnl: fusePnl(gmgnData?.pnl, duneData),

    // Position data
    positions: fusePositions(gmgnData?.positions, fallbackPortfolio?.data),
    openPositionCount: countOpenPositions(gmgnData?.positions, heliusData),

    // Activity metrics
    activity: fuseActivity(heliusData, gmgnData),

    // Risk metrics
    risk: {
      totalTransactions: heliusData?.totalTransactions || 0,
      recentActivity24h: heliusData?.recentActivity24h || 0,
      uniqueTokens: heliusData?.uniqueTokens || 0,
      lpTransactions: heliusData?.lpTransactions || 0,
      deposits: heliusData?.deposits || 0,
      withdrawals: heliusData?.withdrawals || 0,
      swaps: heliusData?.swaps || 0,
    },

    // Token holdings
    tokens: gmgnData?.tokens || heliusData?.tokenBalances || [],

    // Source tracking
    sources: {
      gmgn: !!gmgnData,
      helius: !!heliusData,
      dune: !!duneData,
      fallback: !!fallbackPortfolio,
    },

    // Timestamps
    fetchedAt: Date.now(),
    fusionTimeMs: Date.now() - startTs,
  };

  // Cache the fused result
  cacheSet(cacheKey, fused, { namespace: "fusion", ttlMs: CACHE_TTL_WALLET });
  log("fusion", `Fused wallet data for ${address.slice(0, 12)} in ${fused.fusionTimeMs}ms`);

  return fused;
}

// ─── Top Wallets Selection ─────────────────────────────────────

/**
 * Fuse data for multiple wallets in parallel.
 * @param {string[]} addresses
 * @param {object} [opts]
 * @returns {Promise<object[]>}
 */
export async function fuseMultipleWallets(addresses, opts = {}) {
  const results = await Promise.allSettled(
    addresses.map((addr) => fuseWalletData(addr, opts))
  );
  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
}

/**
 * Fetch and fuse top LP performers from all available sources.
 * @param {object} [opts]
 * @param {number} [opts.count=20]
 * @param {boolean} [opts.forceRefresh=false]
 * @returns {Promise<Array<{address: string, score: number, data: object}>>}
 */
export async function getTopPerformerCandidates(opts = {}) {
  const count = opts.count || 20;
  const cacheKey = `fused:top-candidates`;
  if (!opts.forceRefresh) {
    const cached = cacheGet(cacheKey, { namespace: "fusion", ttlMs: CACHE_TTL_TOP });
    if (cached) return cached;
  }

  // Strategy: gather candidate wallets from multiple sources
  const walletSet = new Set();

  // 1. Existing smart-wallets
  const { getManagedWallets } = await import("../smart-wallets.js").catch(() => ({ getManagedWallets: () => [] }));
  for (const w of (getManagedWallets?.() || [])) {
    walletSet.add(w.address || w);
  }

  // 2. Dune leaderboard (if available)
  if (isDuneAvailable()) {
    const leaderboard = await duneLeaderboard();
    for (const w of (leaderboard || [])) {
      if (w.address) walletSet.add(w.address);
    }
  }

  // 3. From existing ranking system tracked wallets
  const { getAllTrackedWallets } = await import("../ranking/ranking-db.js").catch(() => ({ getAllTrackedWallets: () => [] }));
  const tracked = getAllTrackedWallets?.() || [];
  for (const w of tracked) {
    walletSet.add(w.address || w);
  }

  const addresses = Array.from(walletSet).slice(0, count + 10);
  if (addresses.length === 0) return [];

  // Fuse data for all candidate wallets
  const fusedWallets = await fuseMultipleWallets(addresses, opts);
  const result = fusedWallets.map((w) => ({
    address: w.address,
    label: w.label,
    type: w.type,
    confidence: w.confidence,
    data: w,
  }));

  cacheSet(cacheKey, result, { namespace: "fusion", ttlMs: CACHE_TTL_TOP });
  return result;
}

// ─── Helper Functions ──────────────────────────────────────────

/**
 * Classify wallet type based on available data.
 * @returns {"professional_lp" | "active_trader" | "sniper" | "retail" | "unknown"}
 */
function classifyWalletType(gmgnData, heliusData) {
  const positions = gmgnData?.positions?.length || 0;
  const lpTxns = heliusData?.lpTransactions || 0;
  const deposits = heliusData?.deposits || 0;
  const recentActivity = heliusData?.recentActivity24h || 0;

  if (positions >= 5 && deposits >= 20 && recentActivity > 0) return "professional_lp";
  if (positions >= 2 && lpTxns >= 10) return "active_trader";
  if (deposits === 0 && lpTxns === 0 && gmgnData?.profile) return "sniper";
  if (recentActivity > 0) return "retail";
  return "unknown";
}

/**
 * Calculate data confidence score (0-100).
 * More data sources = higher confidence.
 */
function calculateConfidence(sourceData) {
  const available = sourceData.filter(Boolean).length;
  const total = sourceData.length;
  if (total === 0) return 0;
  return Math.round((available / total) * 100);
}

/**
 * Fuse PnL data from multiple sources.
 */
function fusePnl(gmgnPnl, dunePnl) {
  if (!gmgnPnl && !dunePnl) return null;

  return {
    "7d": {
      pnlUsd: gmgnPnl?.["7d"]?.pnl_usd ?? gmgnPnl?.["7d"]?.pnl ?? dunePnl?.pnl7d ?? null,
      roiPct: gmgnPnl?.["7d"]?.roi_pct ?? gmgnPnl?.["7d"]?.roi ?? null,
      winRate: gmgnPnl?.["7d"]?.win_rate ?? null,
    },
    "30d": {
      pnlUsd: gmgnPnl?.["30d"]?.pnl_usd ?? gmgnPnl?.["30d"]?.pnl ?? dunePnl?.pnl30d ?? null,
      roiPct: gmgnPnl?.["30d"]?.roi_pct ?? gmgnPnl?.["30d"]?.roi ?? null,
      winRate: gmgnPnl?.["30d"]?.win_rate ?? null,
    },
    all: {
      pnlUsd: gmgnPnl?.all?.pnl_usd ?? gmgnPnl?.all?.pnl ?? dunePnl?.pnlAll ?? null,
      roiPct: gmgnPnl?.all?.roi_pct ?? gmgnPnl?.all?.roi ?? null,
      winRate: gmgnPnl?.all?.win_rate ?? null,
    },
    sharpeRatio: dunePnl?.sharpeRatio ?? null,
    maxDrawdown: dunePnl?.maxDrawdown ?? null,
    source: gmgnPnl ? "gmgn" : dunePnl ? "dune" : null,
  };
}

/**
 * Fuse position data.
 */
function fusePositions(gmgnPositions, fallbackData) {
  const positions = [];

  if (Array.isArray(gmgnPositions)) {
    positions.push(...gmgnPositions.map(normalizePosition));
  }

  if (Array.isArray(fallbackData)) {
    for (const fp of fallbackData) {
      // Deduplicate by pool/mint
      const exists = positions.some((p) =>
        p.poolAddress === fp.pool || p.mint === fp.mint
      );
      if (!exists) positions.push(normalizePosition(fp));
    }
  }

  return positions;
}

function normalizePosition(pos) {
  return {
    poolAddress: pos.pool_address || pos.pool || pos.poolAddress || null,
    mint: pos.mint || pos.base_mint || null,
    amountUsd: parseFloat(pos.amount_usd || pos.amount || pos.value || 0),
    feesEarned: parseFloat(pos.fees_earned || pos.fees || 0),
    apr: parseFloat(pos.apr || pos.apr_pct || 0),
    status: pos.status || "active",
    binRange: pos.bin_range || null,
    activeBin: pos.active_bin ?? pos.bin_id ?? null,
  };
}

function countOpenPositions(gmgnPositions, heliusData) {
  if (Array.isArray(gmgnPositions)) {
    return gmgnPositions.filter((p) => !p.status || p.status === "active").length;
  }
  // Fallback: estimate from LP transactions
  if (heliusData) {
    return Math.max(0, (heliusData.deposits || 0) - (heliusData.withdrawals || 0));
  }
  return 0;
}

function fuseActivity(heliusData, gmgnData) {
  return {
    totalTransactions: heliusData?.totalTransactions || 0,
    lpTransactions: heliusData?.lpTransactions || 0,
    recent24h: heliusData?.recentActivity24h || 0,
    uniqueTokens: heliusData?.uniqueTokens || 0,
    deposits: heliusData?.deposits || 0,
    withdrawals: heliusData?.withdrawals || 0,
    swaps: heliusData?.swaps || 0,
    positionsHeld: gmgnData?.positions?.length || 0,
  };
}
