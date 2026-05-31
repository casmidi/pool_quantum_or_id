import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote, isPoolOnCooldown, isBaseMintOnCooldown, applyPoolCooldown } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { runRankingCycle, scoreWalletShort } from "../ranking/top-performers.js";
import { scoreWalletAdvanced, rankWalletsAdvanced } from "../scoring/composite-scorer.js";
import { selectTopWallets, formatSelection } from "../scoring/dynamic-selection.js";
import { getWeightProfile, getAvailableModes } from "../scoring/weight-profiles.js";
import { fuseWalletData, fuseMultipleWallets, getTopPerformerCandidates, getProviderStatus } from "../intelligence/fusion-layer.js";
import { runAllocation } from "../allocation/allocation-engine.js";
import { analyzePositionForCopy } from "../decision/analysis-engine.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { planDlmmEntry } from "../strategy/dlmm-edge.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
// P2 (executor_01): in-memory deploy-pause after emergency flatten.
// Non-zero = deploys blocked; cleared when expired or explicitly reset.
let _deployPausedUntil = 0;
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, requestApproval, isEnabled as telegramEnabled } from "../telegram.js";
import { recordDeploy, recordClose, getOpenTrades, getSummary } from "../lib/pnl_tracker.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// P1 (executor_01): explicit success detection per write-tool — prevents post-success actions
// firing on skipped/blocked/dry-run results that don't carry result.success=true.
function isToolSuccess(name, result) {
  if (!result || result.error || result.blocked) return false;
  if (name === "deploy_position") return result.success === true || result.dry_run === true;
  if (name === "close_position")  return result.success === true || result.dry_run === true;
  if (name === "claim_fees")      return result.success === true || result.dry_run === true;
  if (name === "swap_token")      return result.success === true || !!result.tx;
  return result.success !== false;
}

// P1 (executor_01): uniform position amount estimator — prevents heat/exposure undercount when
// position object lacks a .position key (fallback chain covers tracked state → inline → default).
function estimatePositionAmountSol(p) {
  const tracked = p.position ? getTrackedPosition(p.position) : null;
  return Number(
    tracked?.amount_sol ??
    p.amount_sol ??
    p.initial_amount_sol ??
    config.management.deployAmountSol ??
    0
  );
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  let usingFallback = false;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) {
      // Pool dropped out of discovery API (data sync delay or fell out of trending).
      // The screener already validated it moments ago — use args as fallback rather
      // than blocking a potentially good deploy on a transient API gap.
      log("screening", `Pool ${args.pool_address} not found in re-fetch — falling back to screener data`);
      usingFallback = true;
    }
  } catch (error) {
    log("screening", `Pool re-fetch error: ${error.message} — falling back to screener data`);
    usingFallback = true;
  }

  // P1 (executor_01): Fallback staleness guard — refuse deploy if no validatable fields exist
  // or if screener data is too old. allowStaleScreenerFallback=true bypasses this check.
  if (usingFallback && config.risk.allowStaleScreenerFallback !== true) {
    const hasTvl = args.tvl != null && Number.isFinite(Number(args.tvl));
    const hasFee = args.fee_tvl_ratio != null && Number.isFinite(Number(args.fee_tvl_ratio));
    const hasVol = args.volatility != null && Number.isFinite(Number(args.volatility));
    if (!hasTvl && !hasFee && !hasVol) {
      return { pass: false, reason: "Pool re-fetch failed and no screener fields (tvl/fee/volatility) are available to validate against. Refusing deploy on unverifiable data." };
    }
    if (args.screened_at) {
      const ageMs = Date.now() - new Date(args.screened_at).getTime();
      if (ageMs > 120_000) {
        return { pass: false, reason: `Pool re-fetch failed and screener data is ${Math.round(ageMs / 1000)}s old (limit 120s). Refusing deploy to avoid stale data.` };
      }
    }
  }

  // TVL check — use args.tvl as fallback when detail is unavailable
  const tvl = usingFallback ? numberOrNull(args.tvl) : poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (!usingFallback) {
    if (tvl == null) {
      return { pass: false, reason: "Could not verify pool TVL before deploy." };
    }
    if (minTvl != null && minTvl > 0 && tvl < minTvl) {
      return { pass: false, reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.` };
    }
    if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
      return { pass: false, reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.` };
    }
  } else if (tvl != null) {
    if (minTvl != null && minTvl > 0 && tvl < minTvl) {
      return { pass: false, reason: `Pool TVL $${tvl} (screener data) is below configured minTvl $${minTvl}.` };
    }
    if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
      return { pass: false, reason: `Pool TVL $${tvl} (screener data) is above configured maxTvl $${maxTvl}.` };
    }
  }

  // At short timeframes (5m), fee_active_tvl_ratio can be 0 even for active pools
  // because no fees were collected in that exact window. Fall back to the ratio
  // already verified by the screener (passed in args.fee_tvl_ratio).
  let feeActiveTvlRatio = usingFallback ? null : poolDetailFeeActiveTvlRatio(detail);
  if (!feeActiveTvlRatio && args.fee_tvl_ratio != null) {
    feeActiveTvlRatio = numberOrNull(args.fee_tvl_ratio);
  }
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio != null ? `${(feeActiveTvlRatio * 100).toFixed(4)}%` : "unknown"} is below configured minimum ${(minFeeActiveTvlRatio * 100).toFixed(4)}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if (!usingFallback && (config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  // Use args.volatility as fallback when detail is unavailable
  const volatility = usingFallback
    ? numberOrNull(args.volatility)
    : poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    if (usingFallback) {
      // Screener pre-validated this pool — proceed without volatility check
      log("screening", `Volatility unavailable for ${args.pool_address} (fallback mode) — skipping volatility check`);
    } else {
      return {
        pass: false,
        reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
      };
    }
  }

  const actualBinStep = usingFallback ? numberOrNull(args.bin_step) : poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  return { pass: true };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  fuse_wallet_data: async ({ wallet_address, force_refresh }) => {
    if (!wallet_address) return { error: "wallet_address is required" };
    const result = await fuseWalletData(wallet_address, { forceRefresh: !!force_refresh });
    return result || { error: "Fusion returned no data" };
  },
  fuse_multiple_wallets: async ({ wallet_addresses, force_refresh }) => {
    if (!wallet_addresses || !Array.isArray(wallet_addresses) || wallet_addresses.length === 0)
      return { error: "wallet_addresses array is required" };
    const results = await fuseMultipleWallets(wallet_addresses, { forceRefresh: !!force_refresh });
    return { wallets: results, count: results.length };
  },
  get_provider_status: async () => {
    return { providers: getProviderStatus(), available: getAvailableModes() };
  },
  get_top_performer_candidates: async ({ count, force_refresh }) => {
    const result = await getTopPerformerCandidates({ count: count || 20, forceRefresh: !!force_refresh });
    return { candidates: result, count: result.length };
  },
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  close_all_positions: async ({ reason, skip_swap = false }) => {
    // P1 (ke-08): Emergency flatten — close every open position in sequence.
    // Partial success is allowed: failed positions are recorded but not re-tried.
    const snapshot = await getMyPositions({ force: true, silent: true });
    const open = snapshot?.positions ?? [];
    if (open.length === 0) return { success: true, closed: [], failed: [], message: "No open positions to close." };
    const closed = [], failed = [];
    for (const p of open) {
      try {
        const res = await closePosition({ position_address: p.position, reason: `emergency_flatten: ${reason}`, skip_swap });
        if (res?.success !== false && !res?.error) closed.push(p.position);
        else failed.push({ position: p.position, error: res?.error || "close returned non-success" });
      } catch (e) {
        failed.push({ position: p.position, error: e.message });
      }
    }
    // P2 (executor_01): set a 1-hour deploy pause so the screener doesn't immediately
    // re-open positions after an emergency flatten.
    if (closed.length > 0) {
      _deployPausedUntil = Date.now() + 60 * 60 * 1000;
      log("executor", `Emergency flatten complete — deploys paused for 1h (until ${new Date(_deployPausedUntil).toLocaleTimeString()})`);
    }
    return {
      success: failed.length === 0,
      closed_count: closed.length,
      failed_count: failed.length,
      closed,
      failed,
      message: `Flattened ${closed.length}/${open.length} positions.${failed.length > 0 ? ` ${failed.length} failed — check logs.` : ""} Deploys paused for 1h.`,
    };
  },
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull --ff-only", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: process.cwd(),
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  run_ranking_cycle: async ({ mode, count }) => {
    const result = await runRankingCycle({ mode, count });
    return result || { message: "Ranking cycle completed but returned no data" };
  },
  score_wallet: async ({ wallet_address }) => {
    if (!wallet_address) return { error: "wallet_address is required" };
    return await scoreWalletShort(wallet_address);
  },
  score_wallet_advanced: async ({ wallet_address, mode }) => {
    if (!wallet_address) return { error: "wallet_address is required" };
    const { fetchWalletMetrics } = await import("../ranking/top-performers.js");
    const metrics = await fetchWalletMetrics(wallet_address);
    const result = scoreWalletAdvanced(metrics, mode || "balanced");
    return {
      address: wallet_address,
      label: metrics.label || wallet_address.slice(0, 8),
      ...result,
      rawMetrics: metrics,
    };
  },
  select_top_wallets: async ({ count, mode, min_score, auto_exclude_decaying }) => {
    // Run the full ranking cycle and then apply intelligent selection
    const ranking = await runRankingCycle({ count: Math.max(count || 10, 50), mode });
    const candidates = (ranking?.top || []).map(w => ({
      address: w.address,
      label: w.label || w.address?.slice(0, 8),
      ...w.rawMetrics,
      scoreHistory: w.scoreHistory,
    }));
    const selection = selectTopWallets(candidates, {
      topN: count || 10,
      mode: mode || "balanced",
      whitelist: config.scoring?.whitelist || [],
      blacklist: config.scoring?.blacklist || [],
      minScore: min_score,
      autoExcludeDecaying: auto_exclude_decaying !== false,
    });
    return {
      ...selection,
      formatted: formatSelection(selection),
    };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // P2 (executor_01): persist atomically BEFORE touching live config so they stay in sync.
    // If the write fails (disk full, permissions), return an error — live config is unchanged.
    for (const [key, val] of Object.entries(applied)) {
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    try {
      const tmpPath = `${USER_CONFIG_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(userConfig, null, 2));
      fs.renameSync(tmpPath, USER_CONFIG_PATH);
    } catch (error) {
      return { success: false, error: `Failed to persist config: ${error.message}`, reason };
    }

    // Apply to live config only after file write succeeded
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "close_all_positions",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
    // P0 (executor_01): apply args mutations from safety checks (dynamic sizing, quality/fee
    // scaling) so the actual deploy uses the risk-adjusted amount, not the original args.
    if (safetyCheck.args) args = safetyCheck.args;
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    // P1: Track unconfirmed-submit separately — result.success=null passes the !== false check,
    // so we need an explicit flag to skip post-success actions for submitted_unconfirmed.
    const isUnconfirmedSubmit = result?.status === "submitted_unconfirmed";
    // P1 (executor_01): use explicit per-tool success check instead of loose !error heuristic
    const success = isToolSuccess(name, result);

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    // P1: submitted_unconfirmed — txs were sent but not yet confirmed by portfolio API.
    // Mark the position so the manager knows not to retry. Skip post-success notifications.
    if (isUnconfirmedSubmit) {
      const posAddr = args.position_address || result?.position;
      if (posAddr) {
        setPositionInstruction(posAddr, "pending_close_unconfirmed — do NOT retry close, wait for API to settle");
        log("executor", `submitted_unconfirmed for ${posAddr?.slice(0, 8)} — position marked, skipping post-close actions`);
      }
      result.retry_note = "Close txs submitted but not confirmed. Do NOT call close_position again — check positions in 5-10 minutes.";
    }

    if (success && !isUnconfirmedSubmit) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        const deployedAmountSol = Number(
          result.amount_y
          ?? result.would_deploy?.amount_y
          ?? args.amount_y
          ?? args.amount_sol
          ?? 0,
        );
        // 🔴 BUG FIX: Jangan kirim notifikasi Telegram di dry run — data position/tx kosong.
        // Screening cycle report sudah handle notifikasi dry run.
        if (!result.dry_run) {
          notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: deployedAmountSol, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        } else {
          log("executor", `[Dry run] Would deploy: ${args.pool_name || args.pool_address?.slice(0, 8)} ${deployedAmountSol} SOL`);
        }
        recordDeploy({
          poolAddress: result.pool || args.pool_address,
          poolName: result.pool_name || args.pool_name,
          positionAddress: result.position,
          amountSol: deployedAmountSol,
          isDryRun: Boolean(result.dry_run || process.env.DRY_RUN === "true" || config.dryRun === true),
          strategy: result.strategy ?? args.strategy,
          binsBelow: args.bins_below ?? result.would_deploy?.bins_below,
          activeBin: result.active_bin ?? result.would_deploy?.active_bin,
          lowerBin: result.bin_range?.min ?? null,
          upperBin: result.bin_range?.max ?? null,
          entryPrice: result.range_coverage?.active_price ?? null,
          priceRange: result.price_range ?? null,
          feeTvlRatio: args.fee_tvl_ratio,
          baseMint: args.base_mint,
          binStep: args.bin_step ?? result.bin_step,
          volatility: args.volatility,
          organicScore: args.organic_score,
          holderCount: args.holder_count,
        });
      } else if (name === "close_position") {
        // 🔴 BUG FIX: Jangan kirim notifikasi close di dry run — pnl data kosong.
        if (!result.dry_run) {
          notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        }
        // Ambil harga SOL saat close untuk konversi pnl_usd → pnl_sol yang akurat
        let _solPriceAtClose = null;
        try { const _bal = await getWalletBalances({}); _solPriceAtClose = _bal.sol_price > 0 ? _bal.sol_price : null; } catch { /* ignore */ }
        recordClose({ positionAddress: args.position_address, poolAddress: result.pool || args.pool_address, poolName: result.pool_name || args.position_address?.slice(0, 8), pnlPct: result.pnl_pct ?? null, pnlUsd: result.pnl_usd ?? null, feesUsd: result.fees_usd ?? null, closeReason: args.reason ?? null, solPrice: _solPriceAtClose });
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) try { await addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }); } catch {}
        }
        // P1 (ke-16): Loss-triggered pool cooldown — penalise pools that cause large losses.
        // Cooldown duration scales with loss severity so chronic losers are avoided longer.
        // Only applies to real (non-dry-run) closes with a known PnL figure.
        if (!result.dry_run && config.management.lossTriggeredCooldown) {
          const closePnl = result.pnl_pct ?? null;
          const threshold = config.management.lossCooldownThresholdPct ?? -15;
          if (closePnl != null && Number.isFinite(closePnl) && closePnl < threshold) {
            const poolAddr = result.pool || args.pool_address;
            if (poolAddr) {
              const severity = Math.min(4, Math.ceil(Math.abs(closePnl) / Math.abs(threshold)));
              const cooldownHrs = (config.management.lossCooldownHours ?? 6) * severity;
              try {
                applyPoolCooldown(poolAddr, cooldownHrs, `loss_triggered: pnl=${closePnl.toFixed(1)}%`);
                log("executor", `Loss-triggered cooldown: ${poolAddr.slice(0, 8)} → ${cooldownHrs}h (pnl=${closePnl.toFixed(1)}%)`);
              } catch { /* pool-memory unavailable */ }
            }
          }
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.usd >= 0.10) {
              log("executor", `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              // Tell the model the swap already happened so it doesn't call swap_token again
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // P2 (executor_01): fast in-memory guard — block deploy during recovery pause after flatten
      if (_deployPausedUntil > Date.now()) {
        const remaining = _deployPausedUntil - Date.now();
        return {
          pass: false,
          reason: `Deploys paused until ${new Date(_deployPausedUntil).toLocaleTimeString()} (${Math.ceil(remaining / 60_000)} min remaining) — recovery pause after emergency flatten.`,
        };
      }
      _deployPausedUntil = 0; // expired, clear

      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // P1 (ke-16): Early pool/token cooldown gate — reject before any further computation.
      // isPoolOnCooldown is also enforced inside dlmm.js, but checking here avoids wasted work
      // and gives a cleaner, more informative error message to the LLM.
      if (args.pool_address) {
        if (isPoolOnCooldown(args.pool_address)) {
          const mem = getPoolMemory({ pool_address: args.pool_address });
          const untilStr = mem?.cooldown_until ? ` until ${new Date(mem.cooldown_until).toLocaleTimeString()}` : "";
          const why = mem?.cooldown_reason ? ` (${mem.cooldown_reason})` : "";
          return {
            pass: false,
            reason: `Pool ${args.pool_address.slice(0, 8)} is on cooldown${untilStr}${why}. Choose a different pool.`,
          };
        }
        if (args.base_mint && isBaseMintOnCooldown(args.base_mint)) {
          return {
            pass: false,
            reason: `Token ${args.base_mint.slice(0, 8)} is on cooldown (repeated OOR or low yield). Choose a different token.`,
          };
        }
      }

      let deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      let requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      let requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);

      if (isSingleSidedSol && args.bins_below == null && requestedVolatility != null && requestedVolatility > 0) {
        const plan = planDlmmEntry({
          fee_active_tvl_ratio: args.fee_tvl_ratio,
          bin_step: args.bin_step,
          volatility: requestedVolatility,
          active_pct: args.active_pct,
          price_change_pct: args.price_change_pct,
        }, config);
        requestedBinsBelow = plan.bins_below;
        requestedBinsAbove = 0;
        args = { ...args, strategy: plan.strategy, bins_below: plan.bins_below, bins_above: 0 };
        log("screening", `DLMM edge planner: regime=${plan.regime}, bins_below=${plan.bins_below}, netEV=${plan.projected.net_ev_pct}%/day`);
      }

      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;

      // P1 (ke-08): Dynamic position sizing — scale deploy amount down as volatility rises.
      // scaleFactor = 1 - min(0.4, volatility × 0.08): max 40% reduction at volatility ≥ 5.
      if (config.management.volatilityPositionScaling && requestedVolatility != null && requestedVolatility > 0) {
        const scaleFactor = 1 - Math.min(0.4, requestedVolatility * 0.08);
        const scaled = Math.round(deployAmountY * scaleFactor * 1000) / 1000;
        if (scaled < deployAmountY) {
          log("screening", `Dynamic sizing: vol=${requestedVolatility} → scaleFactor=${scaleFactor.toFixed(3)} → ${deployAmountY} SOL → ${scaled} SOL`);
          deployAmountY = scaled;
          args = { ...args, amount_y: scaled, amount_sol: scaled };
        }
      }

      // P2 (ke-14, ke-15): Pool quality adaptive sizing + composite health score.
      // Health score 0–100 = weighted combination of win rate, avg PnL, OOR rate, sample count.
      // qualityFactor = 0.75 (worst) → 1.0 (no history / good). Uses adjusted_win_rate (excludes
      // emergency closes) so a single bad exit doesn't permanently shrink the position.
      // Health score is always logged for diagnostics even when poolQualityPositionScaling=false.
      let _poolHealthScore = null;
      if (args.pool_address) {
        try {
          const mem = getPoolMemory({ pool_address: args.pool_address });
          if (mem?.known && mem.adjusted_win_rate_sample_count >= 1) {
            const n = mem.adjusted_win_rate_sample_count;
            const winRate = mem.adjusted_win_rate / 100;         // 0–1
            const avgPnlNorm = Math.min(1, Math.max(-1, (mem.avg_pnl_pct ?? 0) / 20)); // -20%=−1, +20%=+1
            const oorPenalty = (() => {
              try {
                if (Array.isArray(mem.history) && mem.history.length >= 2) {
                  const oorCount = mem.history.filter(d => d.close_reason === "out_of_range" || d.close_reason === "oor").length;
                  return oorCount / mem.history.length;
                }
              } catch { /* ignore */ }
              return 0;
            })();
            const confidence = Math.min(1, n / 5); // ramp up over first 5 samples
            const rawScore = (winRate * 0.50 + (avgPnlNorm + 1) / 2 * 0.30 + (1 - oorPenalty) * 0.20) * 100;
            _poolHealthScore = Math.round(rawScore * confidence + 50 * (1 - confidence)); // blend toward 50 for sparse data
            log("screening", `Pool health score [${mem.name || args.pool_address.slice(0, 8)}]: ${_poolHealthScore}/100 (winRate=${mem.adjusted_win_rate}%, avgPnl=${mem.avg_pnl_pct}%, n=${n})`);
          }
        } catch { /* pool-memory unavailable */ }
      }
      if (config.management.poolQualityPositionScaling && args.pool_address && _poolHealthScore !== null) {
        // Use health score (0–100) to derive qualityFactor (0.75–1.0).
        // Score ≥ 60 = full size; score 0–60 scales linearly down to 0.75×.
        const qualityFactor = _poolHealthScore >= 60
          ? 1.0
          : Math.min(1.0, Math.max(0.75, 0.75 + (_poolHealthScore / 60) * 0.25));
        if (qualityFactor < 1.0) {
          const scaled = Math.round(deployAmountY * qualityFactor * 1000) / 1000;
          if (scaled < deployAmountY) {
            log("screening", `Pool quality sizing: healthScore=${_poolHealthScore}/100 → qualityFactor=${qualityFactor.toFixed(3)} → ${deployAmountY} SOL → ${scaled} SOL`);
            deployAmountY = scaled;
            args = { ...args, amount_y: scaled, amount_sol: scaled };
          }
        }
      }

      // P2 (ke-14): Fee yield upscaling — deploy proportionally more in high-yield proven pools.
      // Only scales UP when: fee/TVL is >= goodFeeMultiplier × minimum AND pool has a good track
      // record (or no history). Capped hard at config.risk.maxDeployAmount.
      // Reward pools that earn enough to cover IL: more capital → more absolute fee income.
      if (config.management.feeYieldPositionScaling && args.fee_tvl_ratio != null) {
        const feeRatio = Number(args.fee_tvl_ratio);
        const baseline = (config.screening.minFeeActiveTvlRatio ?? 0.05);
        const goodFeeMultiplier = config.management.goodFeeMultiplier ?? 3.0;
        const goodFeeThreshold = baseline * goodFeeMultiplier;
        const maxDeploy = config.risk.maxDeployAmount ?? 50;
        if (Number.isFinite(feeRatio) && feeRatio >= goodFeeThreshold) {
          // Check pool is not problematic (skip upscale if win rate is low)
          let poolOk = true;
          try {
            const mem = getPoolMemory({ pool_address: args.pool_address });
            if (mem?.known && mem.adjusted_win_rate_sample_count >= 3 && mem.adjusted_win_rate < 40) poolOk = false;
          } catch { /* ignore */ }
          if (poolOk) {
            const excess = (feeRatio - goodFeeThreshold) / goodFeeThreshold;
            const upscale = Math.min(1.5, 1 + excess * 0.5); // max +50% at 3× excess
            const scaled = Math.min(maxDeploy, Math.round(deployAmountY * upscale * 1000) / 1000);
            if (scaled > deployAmountY) {
              log("screening", `Fee yield upscale: fee/TVL=${(feeRatio * 100).toFixed(2)}% (${upscale.toFixed(2)}×) → ${deployAmountY} SOL → ${scaled} SOL`);
              deployAmountY = scaled;
              args = { ...args, amount_y: scaled, amount_sol: scaled };
            }
          }
        }
      }

      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = (process.env.DRY_RUN === "true" || config.dryRun === true)
        ? {
            total_positions: getOpenTrades().length,
            positions: getOpenTrades().map((trade) => ({
              pool: trade.pool_address,
              base_mint: trade.base_mint,
              amount_sol: trade.amount_sol,
            })),
          }
        : await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Intelligent decision layer: explainable pre-copy/deploy judgment.
      // Defaults to advisory mode so dry-run can keep learning without becoming over-strict.
      if (config.decision?.enabled !== false) try {
        const activeBinForDecision = Number(args.active_bin ?? args.activeBin ?? args.current_bin);
        const lowerBin = args.lower_bin ?? args.bin_range?.min ?? (
          Number.isFinite(activeBinForDecision) && Number.isFinite(requestedBinsBelow)
            ? activeBinForDecision - requestedBinsBelow
            : null
        );
        const upperBin = args.upper_bin ?? args.bin_range?.max ?? (
          Number.isFinite(activeBinForDecision) && Number.isFinite(requestedBinsAbove)
            ? activeBinForDecision + requestedBinsAbove
            : null
        );
        const decision = await analyzePositionForCopy({
          poolAddress: args.pool_address,
          poolName: args.pool_name,
          lowerBin,
          upperBin,
          activeBin: Number.isFinite(activeBinForDecision) ? activeBinForDecision : args.active_bin,
          feeTvlRatio: args.fee_tvl_ratio ?? args.fee_active_tvl_ratio,
          volatility: requestedVolatility ?? args.volatility,
          inRange: true,
          ageHours: args.age_hours,
          pnlPct: args.pnl_pct,
          feesEarnedSol: args.fees_earned_sol,
        }, {
          score: Number(args.wallet_score ?? args.ranking_score ?? args.pool_score ?? args.organic_score ?? _poolHealthScore ?? 50),
          grade: args.wallet_grade ?? args.ranking_grade ?? args.pool_grade,
        }, config.decision);

        args = { ...args, decision_result: decision };
        log("decision", `Pre-deploy ${decision.action} confidence=${decision.confidence.toFixed(2)}: ${(decision.reasons || []).slice(0, 2).join("; ")}`);
        if (config.decision?.enforce === true && decision.action !== "COPY") {
          return {
            pass: false,
            reason: `Decision layer blocked deploy: ${decision.action} (${decision.confidence.toFixed(2)}) — ${(decision.reasons || decision.risks || []).join("; ")}`,
          };
        }
      } catch (err) {
        log("decision_warn", `Decision layer unavailable, using existing gates: ${err.message}`);
      }

      // Advanced allocation engine: final pre-deploy sizing and portfolio limit pass.
      // This keeps the older hard gates intact while adding rank/score-aware sizing hooks.
      if (config.allocation?.enabled !== false) try {
        const isDry = process.env.DRY_RUN === "true" || config.dryRun === true;
        const openPositionCount = positions.total_positions ?? positions.positions.length;
        const totalSolDeployed = positions.positions.reduce(
          (sum, p) => sum + (Number(p.amount_sol) || estimatePositionAmountSol(p)),
          0
        );
        const walletSolBalance = isDry
          ? Number(getSummary().current_sol || 0) + totalSolDeployed
          : Number((await getWalletBalances()).sol || 0) + totalSolDeployed;
        const allocation = runAllocation({
          walletSolBalance,
          poolVolatility: requestedVolatility ?? Number(args.volatility ?? 2),
          poolScore: Number(args.pool_score ?? args.organic_score ?? _poolHealthScore ?? 50),
          openPositionCount,
          maxPositions: config.risk.maxPositions,
          totalSolDeployed,
          dailyPnlUsd: null,
          consecutiveOor: 0,
          riskProfile: config.allocation?.riskProfile || "moderate",
          sizingMode: config.allocation?.sizingMode || "score_scaled",
        });
        if (!allocation.allowed) {
          return {
            pass: false,
            reason: `Allocation engine blocked deploy: ${allocation.reason}`,
          };
        }
        const allocated = Math.round(Math.min(deployAmountY, allocation.amountSol) * 1000) / 1000;
        if (Number.isFinite(allocated) && allocated > 0 && allocated < deployAmountY) {
          log("screening", `Allocation sizing: ${deployAmountY} SOL -> ${allocated} SOL (${allocation.reason}; risk=${allocation.riskScore})`);
          deployAmountY = allocated;
          args = { ...args, amount_y: allocated, amount_sol: allocated };
        }
      } catch (err) {
        log("allocation_warn", `Allocation engine unavailable, using existing gates: ${err.message}`);
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance — skip bila dry run (cek keduanya agar konsisten dgn isDryRunMode)
      if (process.env.DRY_RUN !== "true" && config.dryRun !== true) {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }

        // P1 (ke-15): Wallet heat % gate — limit deployed capital as a fraction of total wallet.
        // Wallet heat = (totalDeployed + newDeploy) / (freeSOL + totalDeployed) × 100.
        // Protects against over-concentrating wallet into DLMM positions regardless of absolute limits.
        const maxWalletHeat = config.risk.maxWalletHeatPct;
        if (maxWalletHeat != null && Number.isFinite(maxWalletHeat) && maxWalletHeat > 0 && balance.sol > 0) {
          const totalDeployedForHeat = positions.positions.reduce(
            (sum, p) => sum + estimatePositionAmountSol(p),
            0
          );
          const totalWallet = balance.sol + totalDeployedForHeat;
          const heatAfterDeploy = ((totalDeployedForHeat + amountY) / totalWallet) * 100;
          if (heatAfterDeploy > maxWalletHeat) {
            return {
              pass: false,
              reason: `Wallet heat gate: deploying ${amountY} SOL would put ${heatAfterDeploy.toFixed(1)}% of wallet into active positions, exceeding maxWalletHeatPct of ${maxWalletHeat}%. Current deployed: ${totalDeployedForHeat.toFixed(3)} SOL of ${totalWallet.toFixed(3)} SOL total.`,
            };
          }
        }
      }

      // P1: Portfolio-level risk breaker — pause deploy if trading is going badly.
      // Checks consecutive losses (all-time last N) and 24h total loss.
      // Skip checks in dry-run mode.
      if (process.env.DRY_RUN !== "true" && config.dryRun !== true) {
        const maxConsec = config.risk.maxConsecutiveLosses;
        const maxDailyLoss = config.risk.maxDailyLossUsd;
        if (maxConsec != null && Number.isFinite(maxConsec) && maxConsec > 0) {
          try {
            const recent = getPerformanceHistory({ hours: 24 * 365, limit: maxConsec });
            if (recent.positions.length >= maxConsec) {
              const allLosses = recent.positions.every(p => (p.pnl_usd ?? 0) < 0);
              if (allLosses) {
                return {
                  pass: false,
                  reason: `Portfolio risk breaker: last ${maxConsec} closed positions are all losses. Pausing deploy to prevent further drawdown. Review strategy or increase maxConsecutiveLosses to override.`,
                };
              }
            }
          } catch { /* lessons data unavailable — don't block */ }
        }
        if (maxDailyLoss != null && Number.isFinite(maxDailyLoss) && maxDailyLoss < 0) {
          try {
            const daily = getPerformanceHistory({ hours: 24 });
            if (daily.total_pnl_usd <= maxDailyLoss) {
              return {
                pass: false,
                reason: `Portfolio risk breaker: daily PnL is $${daily.total_pnl_usd.toFixed(2)} USD, below limit of $${maxDailyLoss} USD. Pausing deploy for the day.`,
              };
            }
          } catch { /* lessons data unavailable — don't block */ }
        }
      }

      // P1 (ke-14): Consecutive OOR regime guard — detect trending market from close history.
      // If the last N closed positions were all OOR, the market is likely in a strong directional
      // trend where DLMM LPs repeatedly lose range alignment. Block new deploys to protect capital.
      // Separate from maxConsecutiveLosses (which looks at PnL); this looks at close_reason.
      if (process.env.DRY_RUN !== "true" && config.dryRun !== true) {
        const maxConsecOOR = config.risk.maxConsecutiveOorCloses;
        if (maxConsecOOR != null && Number.isFinite(maxConsecOOR) && maxConsecOOR > 0) {
          try {
            const recent = getPerformanceHistory({ hours: 48, limit: maxConsecOOR });
            if (recent.positions.length >= maxConsecOOR) {
              const allOOR = recent.positions.every(p =>
                p.close_reason === "out_of_range" || p.close_reason === "oor"
              );
              if (allOOR) {
                return {
                  pass: false,
                  reason: `Market regime signal: last ${maxConsecOOR} positions all closed out-of-range within 48h. Market is likely in a strong directional trend — DLMM LP alignment is chronically failing. Pause and reassess before deploying.`,
                };
              }
            }
          } catch { /* lessons data unavailable — don't block */ }
        }
      }

      // P1 (ke-07): Correlated exposure cap — refuse if total SOL deployed would exceed limit.
      // Uses tracked state amounts; missing amounts fall back to deployAmountSol estimate.
      if (process.env.DRY_RUN !== "true" && config.dryRun !== true) {
        const maxExposure = config.risk.maxTotalSolExposure;
        if (maxExposure != null && Number.isFinite(maxExposure) && maxExposure > 0) {
          const totalDeployed = positions.positions.reduce(
            (sum, p) => sum + estimatePositionAmountSol(p),
            0
          );
          if (totalDeployed + amountY > maxExposure) {
            return {
              pass: false,
              reason: `Exposure cap: current ${totalDeployed.toFixed(3)} SOL + new ${amountY} SOL = ${(totalDeployed + amountY).toFixed(3)} SOL would exceed maxTotalSolExposure of ${maxExposure} SOL.`,
            };
          }
        }
      }

      // P1 (ke-07): All-OOR block — refuse new deploy if every open position is out of range.
      // Prevents adding capital when the full portfolio has lost alignment.
      if (config.risk.blockDeployIfAllOOR && positions.positions.length > 0) {
        const allOOR = positions.positions.every(p => p.in_range === false);
        if (allOOR) {
          return {
            pass: false,
            reason: `All ${positions.positions.length} open position(s) are currently out of range. Resolve OOR positions before opening new ones (blockDeployIfAllOOR=true).`,
          };
        }
      }

      // P1 (ke-10): Portfolio heat engine — aggregate stress score across open positions.
      // Each position contributes: 1 (base) +2 (OOR) +1 (OOR>30min) +1 (pnl<-5%) +1 (pnl<-15%)
      // Block new deploy when total heat >= maxPortfolioHeat (null = disabled).
      if (config.risk.maxPortfolioHeat != null && Number.isFinite(config.risk.maxPortfolioHeat)) {
        let portfolioHeat = 0;
        for (const p of positions.positions) {
          let h = 1; // base heat — any open position has cost
          if (p.in_range === false) h += 2;
          if (p.in_range === false && (p.minutes_out_of_range ?? 0) > 30) h += 1;
          const pnl = p.pnl_pct ?? 0;
          if (pnl < -5)  h += 1;
          if (pnl < -15) h += 1;
          portfolioHeat += h;
        }
        if (portfolioHeat >= config.risk.maxPortfolioHeat) {
          return {
            pass: false,
            reason: `Portfolio heat ${portfolioHeat} >= limit ${config.risk.maxPortfolioHeat}. Current positions are under stress (OOR / drawdown). Resolve open positions before adding new capital.`,
          };
        }
      }

      // P1 (ke-07): Market regime gate — refuse deploy above volatility threshold.
      // Uses the 0–5+ volatility scale from screener. Blocks extreme-volatility deployments.
      if (args.volatility != null) {
        const maxVol = config.screening.maxDeployVolatility;
        if (maxVol != null && Number.isFinite(maxVol) && Number(args.volatility) > maxVol) {
          return {
            pass: false,
            reason: `Market regime gate: pool volatility ${args.volatility} exceeds maxDeployVolatility threshold of ${maxVol}. Deploy refused during high-volatility regime.`,
          };
        }
      }

      // P1 (ke-13): Bin-step + volatility compounded IL proxy check.
      // ilMultiplier = binStepFactor × volFactor
      // binStepFactor = 1 + max(0, (bin_step - minBinStep) / 200): ×1.0 at 80, ×1.225 at 125
      // volFactor     = 1 + volatility × 0.05: ×1.0 at vol=0, ×1.25 at vol=5
      // Combined example: bin_step=125 + vol=5 → ×1.53 required fee threshold.
      if (args.fee_tvl_ratio != null && args.bin_step != null) {
        const feeRatio = Number(args.fee_tvl_ratio);
        const bs = Number(args.bin_step);
        const minBS = config.screening.minBinStep ?? 80;
        if (Number.isFinite(feeRatio) && Number.isFinite(bs)) {
          const binStepFactor = 1 + Math.max(0, (bs - minBS) / 200);
          const volFactor = requestedVolatility != null && Number.isFinite(requestedVolatility) && requestedVolatility > 0
            ? 1 + requestedVolatility * 0.05
            : 1;
          const ilMultiplier = binStepFactor * volFactor;
          const adjustedMinFee = (config.screening.minFeeActiveTvlRatio ?? 0) * ilMultiplier;
          if (feeRatio < adjustedMinFee) {
            return {
              pass: false,
              reason: `Fee vs IL check: pool fee/TVL ${(feeRatio * 100).toFixed(3)}% is below adjusted minimum ${(adjustedMinFee * 100).toFixed(3)}% (bin_step=${bs}, vol=${requestedVolatility ?? "?"}, IL multiplier=${ilMultiplier.toFixed(3)}× = binStep×${binStepFactor.toFixed(3)} × vol×${volFactor.toFixed(3)}). Higher-step and higher-volatility pools require proportionally more fees to offset IL risk.`,
            };
          }
        }
      }

      // P2 (ke-09): Pool OOR history guard — toxic flow proxy.
      // If a pool's historical closes are dominated by OOR exits, it shows a chronic toxic
      // regime: the active bin moves too fast for LP to stay in range profitably.
      // Configurable: maxOorRatioForRedeploy (null = disabled, default 0.7 = 70% OOR closes).
      const maxOorRatio = config.screening.maxOorRatioForRedeploy ?? null;
      if (maxOorRatio != null && Number.isFinite(maxOorRatio) && args.pool_address) {
        try {
          const mem = getPoolMemory({ pool_address: args.pool_address });
          if (mem?.known && Array.isArray(mem.history) && mem.history.length >= 3) {
            const oorCloses = mem.history.filter(d => d.close_reason === "out_of_range" || d.close_reason === "oor").length;
            const oorRate = oorCloses / mem.history.length;
            if (oorRate > maxOorRatio) {
              return {
                pass: false,
                reason: `Toxic regime signal: ${Math.round(oorRate * 100)}% of last ${mem.history.length} closes in this pool were out-of-range (limit: ${Math.round(maxOorRatio * 100)}%). Pool shows chronic OOR pattern — active bin moves too fast for LP alignment.`,
              };
            }
          }
        } catch { /* pool-memory unavailable — don't block */ }
      }

      // P1 (ke-16): Fee-vs-IL daily EV estimate — "inti profitability DLMM".
      // Converts fee_tvl_ratio to a projected daily fee yield and subtracts an IL estimate
      // based on bin_step width and pool volatility. Always logged for diagnostic transparency.
      // blockNegativeEV=true + minNetEVPct=0 blocks pools where IL > fees.
      // IL model: bin_step proxy (wider bins lose more when OOR) + volatility proxy.
      if (args.fee_tvl_ratio != null && Number.isFinite(Number(args.fee_tvl_ratio)) && Number(args.fee_tvl_ratio) > 0) {
        const feeRatio = Number(args.fee_tvl_ratio);
        const tfMins  = { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 };
        const periodsPerDay = 1440 / (tfMins[config.screening.timeframe] ?? 30);
        const dailyFeeYieldPct = feeRatio * periodsPerDay * 100;

        // IL estimate components:
        //  binStepIL: bins wider than 10bp widen the price-out-of-range window (×2/day factor)
        //  volIL:     0.4% per volatility unit per day (calibrated for 0–5 scale)
        const bs = Number(args.bin_step ?? 80);
        const binStepIL = Number.isFinite(bs) ? Math.max(0, (bs / 10000) * 200) : 0;
        const volIL = requestedVolatility != null && Number.isFinite(requestedVolatility)
          ? requestedVolatility * 0.4
          : 0;
        const dailyILEstimatePct = binStepIL + volIL;
        const netEvPct = dailyFeeYieldPct - dailyILEstimatePct;
        log("screening", `EV estimate: fee ${dailyFeeYieldPct.toFixed(3)}%/day − IL ~${dailyILEstimatePct.toFixed(3)}%/day = net ${netEvPct >= 0 ? "+" : ""}${netEvPct.toFixed(3)}%/day (bin_step=${bs}, vol=${requestedVolatility ?? "?"})`);

        const minNetEV = config.screening.minNetEVPct ?? null;
        if (config.screening.blockNegativeEV && minNetEV != null && netEvPct < minNetEV) {
          return {
            pass: false,
            reason: `Fee-vs-IL EV gate: projected net EV ${netEvPct.toFixed(2)}%/day is below minimum ${minNetEV}%/day (daily fee ${dailyFeeYieldPct.toFixed(2)}% − IL estimate ${dailyILEstimatePct.toFixed(2)}%). Pool expected to lose money — choose a higher-yield or lower-volatility pool.`,
          };
        }
      }

      // P2 (ke-13): Historical pool win rate gate.
      // If this pool has been deployed before and its adjusted win rate (excluding emergency
      // closes) falls below the configured minimum, block redeployment. Requires at least 3
      // samples to avoid false negatives from small sample sizes.
      const minPoolWinRate = config.screening.minPoolWinRate ?? null;
      if (minPoolWinRate != null && Number.isFinite(minPoolWinRate) && args.pool_address) {
        try {
          const mem = getPoolMemory({ pool_address: args.pool_address });
          if (mem?.known && mem.adjusted_win_rate_sample_count >= 3 && mem.adjusted_win_rate < minPoolWinRate) {
            return {
              pass: false,
              reason: `Pool history gate: adjusted win rate ${mem.adjusted_win_rate}% (${mem.adjusted_win_rate_sample_count} samples) is below minimum ${minPoolWinRate}% for pool ${args.pool_address.slice(0, 8)}. This pool has a chronically poor track record.`,
            };
          }
        } catch { /* pool-memory unavailable — don't block */ }
      }

      // Manual approval gate — if enabled, ask user via Telegram before deploying
      if (config.requireApproval && telegramEnabled()) {
        const poolName = args.pool_name || args.pool_address?.slice(0, 8) || "unknown";
        const tvlStr = args.tvl != null ? `$${Number(args.tvl).toLocaleString()}` : "?";
        const feeTvl = args.fee_tvl_ratio != null ? `${(Number(args.fee_tvl_ratio) * 100).toFixed(2)}%` : "?";
        const organic = args.organic != null ? args.organic : "?";
        const approvalText = [
          `🔔 <b>Deploy Approval Required</b>`,
          ``,
          `Pool: <b>${poolName}</b>`,
          `Amount: <b>${amountY} SOL</b>`,
          `TVL: ${tvlStr} | Fee/TVL: ${feeTvl} | Organic: ${organic}`,
          ``,
          `Setuju deploy? Jika tidak dijawab dalam 1 menit, deploy <b>dibatalkan</b>.`,
        ].join("\n");
        log("screening", `Waiting for manual approval: ${poolName}`);
        const { approved, reason } = await requestApproval({ text: approvalText, timeoutMs: 60_000 });
        if (!approved) {
          return {
            pass: false,
            reason: `Deploy ditolak pengguna atau timeout (${reason}): ${poolName}`,
          };
        }
        log("screening", `Manual approval granted: ${poolName}`);
      }

      // P0 (executor_01): return the (possibly mutated) args so executeTool can use the
      // risk-adjusted deploy amount instead of the original LLM-supplied value.
      return { pass: true, args };
    }

    case "close_position": {
      // P0: data_quality guard — if position only has portfolio data (no bin/PnL detail),
      // auto-close decisions based on PnL or range may be inaccurate.
      // Only emergency reasons (stop_loss, out_of_range, emergency, force) bypass this.
      const emergencyKeywords = ["stop_loss", "stop loss", "out_of_range", "out of range", "emergency", "force"];
      const reason = String(args.reason || "").toLowerCase();
      const isEmergency = emergencyKeywords.some(k => reason.includes(k));
      if (!isEmergency) {
        try {
          const cached = await getMyPositions({ force: false, silent: true });
          const pos = cached?.positions?.find(p => p.position === args.position_address);
          if (pos?.data_quality === "portfolio_only") {
            return {
              pass: false,
              reason: `Position ${args.position_address?.slice(0, 8)} has data_quality=portfolio_only — bin data not available, PnL may be inaccurate. Only emergency closes (stop_loss, out_of_range) are allowed. Pass reason='emergency' or 'force' to override.`,
            };
          }
        } catch {
          // If positions fetch fails, don't block — close is user-initiated
        }
      }
      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
