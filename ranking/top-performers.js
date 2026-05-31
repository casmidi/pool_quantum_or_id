/**
 * ranking/top-performers.js
 * Smart Top 10 — Ranking Orchestrator
 *
 * Fetches wallet performance data from multiple sources:
 * - Birdeye API (wallet PnL, portfolio)
 * - Helius DAS API (token balances, transaction history)
 * - Meteora LPAgent API (LP-specific performance)
 * - GMGN.ai (wallet performance metrics)
 *
 * Orchestrates the full ranking cycle: fetch → score → rank → store.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scoreWallet, rankWallets } from "./scorer.js";
import { selectTopWallets } from "../scoring/dynamic-selection.js";
import {
  recordWalletPerformance,
  saveRankingSnapshot,
  getAllTrackedWallets,
  getLatestSnapshot,
  tagWallet,
  untagWallet,
} from "./ranking-db.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "../tools/agent-meridian.js";
import { getTopCandidates } from "../tools/screening.js";
import { studyTopLPers } from "../tools/study.js";
import { getTopPerformerCandidates } from "../intelligence/fusion-layer.js";

// ─── API Fetch Helpers ─────────────────────────────────────────

const BIRDEYE_BASE = "https://public-api.birdeye.so/public";
const HELIUS_BASE = "https://api.helius.xyz/v0";
const GMGN_BASE   = "https://api.gmgn.ai/v1";

const BIRDEYE_API_KEY = config?.ranking?.birdeyeApiKey || process.env.BIRDEYE_API_KEY || "";
const HELIUS_API_KEY  = config?.ranking?.heliusApiKey  || process.env.HELIUS_API_KEY  || "";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PNL_LOG_PATH = path.join(__dirname, "..", "data", "pnl_log.json");

/**
 * Fetch Birdeye wallet portfolio data.
 * Birdeye gives us PnL, portfolio value, realized/unrealized PnL.
 * @param {string} wallet
 * @returns {Promise<object|null>}
 */
async function fetchBirdeyePortfolio(wallet) {
  if (!BIRDEYE_API_KEY) return null;
  try {
    const url = `${BIRDEYE_BASE}/portfolio?wallet=${wallet}`;
    const res = await fetch(url, {
      headers: { "X-API-KEY": BIRDEYE_API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.success || !json.data) return null;

    const d = json.data;
    return {
      pnl7d:           d.realizedPnl7d ?? d.pnl7d ?? null,
      pnl30d:          d.realizedPnl30d ?? d.pnl30d ?? null,
      portfolioValue:  d.totalUsd ?? null,
      unrealizedPnl:   d.unrealizedPnl ?? null,
      source: "birdeye",
    };
  } catch (err) {
    log("ranking", `Birdeye fetch failed for ${wallet.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch wallet LP positions from Meteora LPAgent API.
 * This gives us LP-specific performance: fees earned, positions,
 * volatility, bin ranges used.
 * @param {string} wallet
 * @returns {Promise<object|null>}
 */
async function fetchMeteoraLpData(wallet) {
  try {
    const base = getAgentMeridianBase();
    const headers = getAgentMeridianHeaders();
    const url = `${base}/v1/wallet/${wallet}/positions`;
    const res = await fetch(url, {
      headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();

    const positions = json?.data || json?.positions || [];
    if (!positions.length) return null;

    // Aggregate LP metrics
    let totalFees = 0;
    let totalVolume = 0;
    let winCount = 0;
    let lossCount = 0;
    let maxDrawdown = 0;

    for (const pos of positions) {
      totalFees += Number(pos.fees_earned_sol ?? pos.fees ?? 0);
      totalVolume += Number(pos.volume_sol ?? pos.volume ?? 0);
      const pnl = Number(pos.pnl_sol ?? pos.pnl ?? 0);
      if (pnl > 0) winCount++;
      else if (pnl < 0) lossCount++;
      const dd = Number(pos.max_drawdown_pct ?? 0);
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    return {
      feesEarned:     totalFees,
      lpVolumeSol:    totalVolume,
      winRate:        (winCount + lossCount) > 0 ? (winCount / (winCount + lossCount)) * 100 : null,
      maxDrawdownPct: maxDrawdown,
      positionCount:  positions.length,
      positions:      positions.slice(0, 20),
      source: "meteora_lpagent",
    };
  } catch (err) {
    log("ranking", `Meteora LPAgent fetch failed for ${wallet.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch wallet data from GMGN.ai API.
 * GMGN provides trader performance metrics: PnL, win rate, fees, etc.
 * @param {string} wallet
 * @returns {Promise<object|null>}
 */
async function fetchGmgnData(wallet) {
  try {
    // GMGN free endpoint — no API key needed
    const url = `${GMGN_BASE}/solana/wallet/${wallet}/performance`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.data || json;

    if (!d) return null;

    return {
      pnl7d:           d.pnl_7d ?? d.pnl7d ?? null,
      pnl30d:          d.pnl_30d ?? d.pnl30d ?? null,
      winRate:         d.win_rate ?? d.winRate ?? null,
      feesEarned:      d.total_fees ?? d.fees ?? null,
      maxDrawdownPct:  d.max_drawdown ?? d.maxDrawdown ?? null,
      daysActive30d:   d.active_days_30d ?? d.daysActive ?? null,
      volumeTraded:    d.volume_total ?? d.volume ?? null,
      source: "gmgn",
    };
  } catch (err) {
    log("ranking", `GMGN fetch failed for ${wallet.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch wallet token balances and transaction history from Helius.
 * Used as a fallback to compute approximate activity metrics.
 * @param {string} wallet
 * @returns {Promise<{daysActive30d: number|null, source: string}|null>}
 */
async function fetchHeliusActivity(wallet) {
  if (!HELIUS_API_KEY) return null;
  try {
    // Helius DAS API: get assets by owner to check recent activity
    const body = {
      jsonrpc: "2.0",
      id: "1",
      method: "getAssetsByOwner",
      params: {
        ownerAddress: wallet,
        page: 1,
        limit: 100,
        displayOptions: { showFungible: true },
      },
    };
    const res = await fetch(`${HELIUS_BASE}/addresses/${wallet}/transactions?apiKey=${HELIUS_API_KEY}&limit=10`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();

    // Count unique days from transactions
    const txns = Array.isArray(json) ? json : [];
    if (!txns.length) return null;

    const days = new Set();
    for (const tx of txns) {
      const ts = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();
      const dayKey = ts.toISOString().slice(0, 10);
      days.add(dayKey);
    }

    return {
      daysActive30d: days.size,
      lastTx: txns[0]?.timestamp || null,
      source: "helius",
    };
  } catch (err) {
    log("ranking", `Helius fetch failed for ${wallet.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

// ─── Data Merging ─────────────────────────────────────────────

/**
 * Merge wallet data from multiple sources into a single normalized object.
 * Later sources override earlier ones where they have data.
 */
function mergeWalletData(sources) {
  const merged = {
    pnl7d: null,
    pnl30d: null,
    pnlAll: null,
    roi7dPct: null,
    roi30dPct: null,
    feesEarned: null,
    feeApr: null,
    winRate: null,
    profitFactor: null,
    maxDrawdownPct: null,
    daysActive30d: null,
    lpVolumeSol: null,
    positionCount: null,
    rangeEfficiency: null,
    lastSeen: null,
    source: null,
  };

  for (const src of sources) {
    if (!src) continue;
    for (const key of Object.keys(merged)) {
      if (src[key] != null && merged[key] == null) {
        merged[key] = src[key];
      }
    }
    if (src.source) merged.source = src.source;
    if (src.lastSeen && (!merged.lastSeen || src.lastSeen > merged.lastSeen)) {
      merged.lastSeen = src.lastSeen;
    }
  }

  // If daysActive30d is still null, infer from having recent activity
  if (merged.daysActive30d == null && merged.pnl7d != null) {
    merged.daysActive30d = merged.pnl7d !== 0 ? 7 : 1;
  }

  return merged;
}

// ─── Main Ranking Orchestration ───────────────────────────────

/**
 * Fetch wallet performance data from all available sources.
 * @param {string} walletAddress
 * @param {object} [overrides] - Optional manual data overrides
 * @returns {Promise<object>} Normalized wallet data
 */
function normalizeAddress(value) {
  const address = String(value || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : null;
}

function addWalletCandidate(walletMap, candidate, source = "unknown") {
  const address = normalizeAddress(candidate?.address || candidate?.owner || candidate?.wallet);
  if (!address) return false;
  const existing = walletMap.get(address) || {};
  walletMap.set(address, {
    ...existing,
    ...candidate,
    address,
    label: existing.label || candidate.label || candidate.name || candidate.owner_short || address.slice(0, 8),
    source: existing.source ? `${existing.source},${source}` : (candidate.source || source),
  });
  return true;
}

function metricsFromLper(lper, pool = {}) {
  const s = lper?.summary || {};
  const roiPct = Number(s.roi) * 100;
  const winRateRaw = Number(s.win_rate);
  const winRate = winRateRaw <= 1 ? winRateRaw * 100 : winRateRaw;
  const totalPnlUsd = Number(s.total_pnl_usd || 0);
  const fees = Number(s.fee_pct_of_capital || s.avg_fee_per_tvl_24h_pct || 0);
  const pnlProxy = Number.isFinite(totalPnlUsd) ? totalPnlUsd / 100 : 0;
  return {
    address: lper.owner,
    label: lper.owner_short || lper.owner?.slice(0, 8),
    pnl7d: pnlProxy,
    pnl30d: pnlProxy * 3,
    pnlAll: pnlProxy * 5,
    roi7dPct: Number.isFinite(roiPct) ? roiPct : null,
    roi30dPct: Number.isFinite(roiPct) ? roiPct : null,
    feesEarned: Number.isFinite(fees) ? fees : null,
    feeApr: Number.isFinite(fees) ? fees * 24 : null,
    winRate: Number.isFinite(winRate) ? winRate : null,
    profitFactor: Number.isFinite(winRate) && winRate > 0 ? Math.max(0.1, winRate / Math.max(1, 100 - winRate)) : null,
    maxDrawdownPct: Number(s.avg_open_pnl_pct) < 0 ? Math.abs(Number(s.avg_open_pnl_pct)) : 10,
    daysActive30d: Math.max(1, Math.min(30, Number(s.total_positions || 1))),
    lpVolumeSol: Math.max(1, Number(s.total_balance_usd || 0) / 100),
    positionCount: Number(s.total_positions || 0),
    rangeEfficiency: s.preferred_range_style && s.preferred_range_style !== "unknown" ? 70 : 50,
    poolContext: pool.pool_name || pool.name || null,
    source: "lpagent_top_lper",
  };
}

function flattenFusedCandidate(candidate) {
  const data = candidate?.data || candidate || {};
  const pnl = data.pnl || {};
  const pnl7 = pnl["7d"] || pnl.week || {};
  const pnl30 = pnl["30d"] || pnl.month || {};
  return {
    address: candidate.address || data.address,
    label: candidate.label || data.label,
    pnl7d: Number(pnl7.pnl ?? pnl7.pnlUsd ?? data.pnl7d ?? candidate.pnl7d ?? 0),
    pnl30d: Number(pnl30.pnl ?? pnl30.pnlUsd ?? data.pnl30d ?? candidate.pnl30d ?? 0),
    pnlAll: Number(pnl.all?.pnl ?? pnl.all?.pnlUsd ?? data.pnlAll ?? candidate.pnlAll ?? 0),
    winRate: Number(pnl30.winRate ?? data.winRate ?? candidate.winRate ?? 0),
    maxDrawdownPct: Number(pnl30.maxDrawdown ?? data.maxDrawdownPct ?? candidate.maxDrawdownPct ?? 0),
    feesEarned: Number(data.feesEarned ?? candidate.feesEarned ?? 0),
    positionCount: data.openPositionCount ?? candidate.positionCount ?? 0,
    source: candidate.source || "fusion",
  };
}

async function addFusionCandidates(walletMap, count, options = {}) {
  try {
    const candidates = await getTopPerformerCandidates({
      count,
      forceRefresh: !!options.forceRefresh,
    });
    for (const c of candidates || []) {
      addWalletCandidate(walletMap, flattenFusedCandidate(c), "fusion");
    }
  } catch (err) {
    log("ranking", `Fusion candidate discovery skipped: ${err.message}`);
  }
}

async function addTopLperCandidatesFromPools(walletMap, options = {}) {
  const poolLimit = Math.max(1, Number(options.poolLimit ?? config.ranking?.discoveryPoolLimit ?? 5));
  const lperLimit = Math.max(1, Number(options.lperLimit ?? config.ranking?.topLpersPerPool ?? 4));
  try {
    const top = await getTopCandidates({ limit: poolLimit }).catch(() => null);
    let pools = (top?.candidates || top?.pools || []).slice(0, poolLimit);
    if (!pools.length) {
      pools = getRecentPoolsFromPnl(poolLimit).map((pool_address) => ({ pool_address }));
    }
    for (const pool of pools) {
      const poolAddress = pool.pool || pool.pool_address || pool.address;
      if (!poolAddress) continue;
      const study = await studyTopLPers({ pool_address: poolAddress, limit: lperLimit }).catch(() => null);
      for (const lper of study?.lpers || []) {
        addWalletCandidate(walletMap, metricsFromLper(lper, study || pool), "top_lper");
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (err) {
    log("ranking", `Top-LPer discovery skipped: ${err.message}`);
  }
}

function getRecentPoolsFromPnl(limit = 5) {
  try {
    if (!fs.existsSync(PNL_LOG_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(PNL_LOG_PATH, "utf8"));
    const seen = new Set();
    return (Array.isArray(data?.trades) ? data.trades : [])
      .slice()
      .sort((a, b) => new Date(b.deploy_time || b.close_time || 0) - new Date(a.deploy_time || a.close_time || 0))
      .map((trade) => String(trade.pool_address || "").trim())
      .filter((poolAddress) => {
        if (!poolAddress || seen.has(poolAddress)) return false;
        seen.add(poolAddress);
        return true;
      })
      .slice(0, limit);
  } catch (err) {
    log("ranking", `PnL pool fallback skipped: ${err.message}`);
    return [];
  }
}

export async function fetchWalletMetrics(walletAddress, overrides = {}) {
  // Fetch from all sources in parallel
  const [birdeye, meteora, gmgn, helius] = await Promise.all([
    fetchBirdeyePortfolio(walletAddress),
    fetchMeteoraLpData(walletAddress),
    fetchGmgnData(walletAddress),
    fetchHeliusActivity(walletAddress),
  ]);

  const merged = mergeWalletData([overrides, gmgn, meteora, birdeye, helius]);
  return merged;
}

/**
 * Run the full ranking cycle.
 *
 * 1. Read tracked wallets from smart-wallets list + ranking-db
 * 2. Fetch fresh metrics for each wallet from all APIs
 * 3. Score and rank using current strategy mode
 * 4. Persist results to ranking-db
 * 5. Return top N wallets
 *
 * @param {object} [options]
 * @param {number}  [options.count=10] - Number of wallets to return
 * @param {string}  [options.mode]     - Override strategy mode
 * @param {Array<{address: string, label?: string}>} [options.additionalWallets] - Extra wallets to include
 * @returns {Promise<{ top: Array, snapshot: object, timestamp: string }>}
 */
export async function runRankingCycle(options = {}) {
  const count = options.count ?? 10;
  const mode  = options.mode || config.ranking?.strategyMode || "auto_top_10";

  log("ranking", `Starting ranking cycle (mode=${mode}, target_top=${count})`);

  // ── 1. Gather wallet addresses to evaluate ──
  const { getManagedWallets } = await import("../smart-wallets.js");
  const managed = getManagedWallets ? getManagedWallets() : [];

  // Always include tracked wallets from ranking-db
  const dbWallets = getAllTrackedWallets();

  // Merge wallet lists — deduplicate by address
  const walletMap = new Map();

  // Start with smart-wallets managed list (these have labels/names)
  for (const w of managed) {
    walletMap.set(w.address, {
      address: w.address,
      label: w.label || w.name || w.address?.slice(0, 8),
      pnl7d: w.pnl7d,
      pnl30d: w.pnl30d,
      feesEarned: w.feesEarned,
      winRate: w.winRate,
      maxDrawdownPct: w.maxDrawdownPct,
      daysActive30d: w.daysActive30d,
      lpVolumeSol: w.lpVolumeSol,
      source: w.source || "smart_wallets",
    });
  }

  // Add DB wallet entries where we have historical metrics
  for (const w of dbWallets) {
    if (!walletMap.has(w.address)) {
      walletMap.set(w.address, {
        address: w.address,
        label: w.address?.slice(0, 8),
        ...(w.metrics || {}),
        source: w.source || "ranking_db",
      });
    }
  }

  // Add any additional wallets from options
  if (options.additionalWallets) {
    for (const w of options.additionalWallets) {
      if (!walletMap.has(w.address)) {
        walletMap.set(w.address, {
          address: w.address,
          label: w.label || w.address?.slice(0, 8),
          source: "manual",
        });
      }
    }
  }

  await addFusionCandidates(walletMap, Math.max(count || 10, config.ranking?.maxWalletsToTrack || 50), options);
  await addTopLperCandidatesFromPools(walletMap, options);

  const walletAddresses = Array.from(walletMap.keys());
  log("ranking", `Evaluating ${walletAddresses.length} wallets`);

  if (walletAddresses.length === 0) {
    log("ranking", "No wallets to rank. Returning empty result.");
    return { top: [], snapshot: null, timestamp: new Date().toISOString() };
  }

  // ── 2. Fetch fresh metrics for all wallets ──
  const fetchPromises = walletAddresses.map(async (addr) => {
    const existing = walletMap.get(addr);
    const metrics = await fetchWalletMetrics(addr, {
      pnl7d: existing.pnl7d,
      pnl30d: existing.pnl30d,
      pnlAll: existing.pnlAll,
      roi7dPct: existing.roi7dPct,
      roi30dPct: existing.roi30dPct,
      feesEarned: existing.feesEarned,
      feeApr: existing.feeApr,
      winRate: existing.winRate,
      profitFactor: existing.profitFactor,
      maxDrawdownPct: existing.maxDrawdownPct,
      daysActive30d: existing.daysActive30d,
      lpVolumeSol: existing.lpVolumeSol,
      positionCount: existing.positionCount,
      rangeEfficiency: existing.rangeEfficiency,
      source: existing.source,
    });
    return { address: addr, label: existing.label, scoreHistory: existing.scoreHistory || [], ...metrics };
  });

  const fetchedWallets = await Promise.allSettled(fetchPromises);
  const walletData = [];
  for (const result of fetchedWallets) {
    if (result.status === "fulfilled") {
      walletData.push(result.value);
    } else {
      log("ranking", `Fetch failed for a wallet: ${result.reason?.message || "unknown"}`);
    }
  }

  // ── 3. Score and rank ──
  const ranked = rankWallets(walletData, mode);
  const selection = selectTopWallets(walletData, {
    topN: count,
    mode,
    whitelist: config.scoring?.whitelist || [],
    blacklist: config.scoring?.blacklist || [],
    minScore: config.scoring?.minScoreThreshold,
    autoExcludeDecaying: config.scoring?.autoExcludeDecaying !== false,
    checkCorrelation: config.scoring?.checkCorrelation !== false,
  });
  const selectedSet = new Set((selection.selected || []).map((w) => w.address));
  const top = ranked.filter((w) => selectedSet.has(w.address)).slice(0, count);

  // ── 4. Persist to ranking-db ──
  // Record each wallet's performance
  for (const w of walletData) {
    recordWalletPerformance(w.address, {
      pnl7d: w.pnl7d,
      pnl30d: w.pnl30d,
      feesEarned: w.feesEarned,
      winRate: w.winRate,
      maxDrawdownPct: w.maxDrawdownPct,
      daysActive30d: w.daysActive30d,
      lpVolumeSol: w.lpVolumeSol,
      source: w.source,
    });
  }

  // Save ranking snapshot
  const snapshot = saveRankingSnapshot(ranked, mode);

  log("ranking", `Ranking complete: top=${top.length} wallets, #1 score=${top[0]?.score ?? "N/A"} (grade ${top[0]?.grade ?? "?"})`);

  return {
    top,
    snapshot,
    selection,
    timestamp: snapshot.ts,
  };
}

export async function getTopWallets(count = 10, mode = "balanced", options = {}) {
  const result = await runRankingCycle({ ...options, count, mode });
  return result.top || [];
}

/**
 * Quick fetch wallet metrics + score for a single wallet.
 * Useful for manual check or before copy-decision.
 * @param {string} walletAddress
 * @returns {Promise<object>}
 */
export async function scoreWalletShort(walletAddress) {
  const metrics = await fetchWalletMetrics(walletAddress);
  const result = scoreWallet(metrics);
  return {
    address: walletAddress,
    ...result,
    metrics,
  };
}

// ─── Source Data Export ────────────────────────────────────────

export { fetchBirdeyePortfolio, fetchMeteoraLpData, fetchGmgnData, fetchHeliusActivity };
