import "dotenv/config";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getWalletPositions } from "../tools/dlmm.js";
import { getPoolDetail } from "../tools/screening.js";
import { getLatestSnapshot, tagWallet } from "../ranking/ranking-db.js";
import { runRankingCycle } from "../ranking/top-performers.js";
import { analyzePositionForCopy } from "../decision/analysis-engine.js";
import {
  getRecentCopySignals,
  hasRecentCopySignal,
  recordCopySignal,
  recordIgnoredCopySignal,
  touchCopyRun,
} from "./copy-state.js";

function normalizeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function snapshotFresh(snapshot, maxAgeMs) {
  const ts = new Date(snapshot?.ts || 0).getTime();
  return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
}

async function getTopWalletEntries({ count, mode, forceRanking = false }) {
  const maxAgeMs = Number(config.copyTrading?.rankingMaxAgeMinutes ?? 360) * 60_000;
  const hardMaxAgeMs = Number(config.copyTrading?.rankingHardMaxAgeMinutes ?? 1440) * 60_000;
  let snapshot = !forceRanking ? getLatestSnapshot() : null;

  if (!snapshotFresh(snapshot, maxAgeMs) && forceRanking) {
    const ranking = await runRankingCycle({ count: Math.max(count, config.ranking?.topN || 10), mode });
    snapshot = ranking?.snapshot || getLatestSnapshot();
  }

  if (!snapshotFresh(snapshot, hardMaxAgeMs)) return [];

  return (snapshot?.entries || [])
    .filter((entry) => entry?.address)
    .slice()
    .sort((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999))
    .slice(0, count);
}

async function enrichPosition(position) {
  const poolAddress = position.pool || position.pool_address;
  if (!poolAddress) return position;

  let detail = null;
  try {
    detail = await getPoolDetail({ pool_address: poolAddress });
  } catch (err) {
    log("copy_engine", `Pool detail unavailable for ${poolAddress.slice(0, 8)}: ${err.message}`);
  }

  return {
    ...position,
    poolAddress,
    poolName: detail?.name || detail?.pool_name || position.pool_name || null,
    feeTvlRatio: normalizeNumber(
      detail?.fee_tvl_ratio ??
      detail?.fee_active_tvl_ratio ??
      detail?.metrics?.fee_tvl_ratio,
      normalizeNumber(position.fee_tvl_ratio, 0)
    ),
    volatility: normalizeNumber(
      detail?.volatility ??
      detail?.metrics?.volatility ??
      position.volatility,
      0
    ),
    binStep: detail?.bin_step ?? detail?.dlmm_params?.bin_step ?? position.bin_step ?? null,
    organicScore: detail?.organic_score ?? detail?.organicScore ?? null,
  };
}

function buildDeployArgs({ position, walletEntry, amountSol }) {
  const activeBin = normalizeNumber(position.active_bin ?? position.activeBin);
  const lowerBin = normalizeNumber(position.lower_bin ?? position.lowerBin);
  const upperBin = normalizeNumber(position.upper_bin ?? position.upperBin);
  const binsBelow = activeBin != null && lowerBin != null
    ? Math.max(0, activeBin - lowerBin)
    : null;
  const binsAbove = activeBin != null && upperBin != null
    ? Math.max(0, upperBin - activeBin)
    : 0;

  return {
    pool_address: position.poolAddress || position.pool || position.pool_address,
    pool_name: position.poolName || null,
    amount_y: amountSol,
    amount_sol: amountSol,
    amount_x: 0,
    bins_below: binsBelow,
    bins_above: binsAbove,
    active_bin: activeBin,
    lower_bin: lowerBin,
    upper_bin: upperBin,
    bin_step: position.binStep,
    fee_tvl_ratio: position.feeTvlRatio,
    volatility: position.volatility,
    organic_score: position.organicScore,
    wallet_score: walletEntry.score,
    wallet_grade: walletEntry.grade,
    source_wallet: walletEntry.address,
    source_wallet_rank: walletEntry.rank,
    source: "copy_engine",
  };
}

function recommendAmount(walletEntry) {
  const base = Number(config.copyTrading?.baseAmountSol ?? config.management?.deployAmountSol ?? 0.1);
  const max = Number(config.copyTrading?.maxAmountSol ?? config.risk?.maxDeployAmount ?? base);
  const rank = Number(walletEntry.rank || 10);
  const score = Math.max(0, Math.min(100, Number(walletEntry.score || 0)));
  const rankFactor = Math.max(0.5, 1.25 - (rank - 1) * 0.06);
  const scoreFactor = Math.max(0.5, score / 70);
  return Math.round(Math.min(max, base * rankFactor * scoreFactor) * 1000) / 1000;
}

async function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function evaluateWallet(walletEntry, options = {}) {
  const wallet = walletEntry.address;
  const result = await withTimeout(
    getWalletPositions({ wallet_address: wallet }),
    Number(config.copyTrading?.walletFetchTimeoutMs ?? 20_000),
    `wallet position fetch ${wallet.slice(0, 8)}`
  );
  const positions = (result?.positions || []).slice(0, Number(config.copyTrading?.maxPositionsPerWallet ?? 3));
  const signals = [];
  const ignored = [];

  for (const rawPosition of positions) {
    const position = await enrichPosition(rawPosition);
    const pool = position.poolAddress || position.pool;
    const duplicate = hasRecentCopySignal({
      wallet,
      position: position.position,
      pool,
      ttlMs: Number(config.copyTrading?.dedupeMinutes ?? 720) * 60_000,
    });
    if (duplicate) {
      ignored.push(recordIgnoredCopySignal({
        wallet,
        pool,
        position: position.position,
        action: "SKIP",
        reason: "recent_duplicate_signal",
      }));
      continue;
    }

    const decision = await analyzePositionForCopy(position, walletEntry, config.decision);
    const action = decision.action === "COPY" && decision.confidence >= Number(config.decision?.minConfidence ?? 0.6)
      ? "COPY"
      : decision.action;

    const signal = {
      wallet,
      walletLabel: walletEntry.label || wallet.slice(0, 8),
      walletRank: walletEntry.rank,
      walletScore: walletEntry.score,
      walletGrade: walletEntry.grade,
      pool,
      poolName: position.poolName,
      position: position.position,
      action,
      confidence: decision.confidence,
      reasons: decision.reasons || [],
      risks: decision.risks || [],
      deployArgs: action === "COPY"
        ? buildDeployArgs({ position, walletEntry, amountSol: recommendAmount(walletEntry) })
        : null,
      dryRun: options.dryRun ?? config.copyTrading?.dryRun ?? true,
      source: "copy_engine",
    };

    if (action === "COPY") signals.push(recordCopySignal(signal));
    else ignored.push(recordIgnoredCopySignal(signal));
  }

  return {
    wallet,
    totalPositions: positions.length,
    signals,
    ignored,
    error: result?.error || null,
  };
}

export async function runCopyEngineCycle(options = {}) {
  if (config.copyTrading?.enabled === false) {
    return { ok: true, skipped: true, reason: "copyTrading.enabled=false" };
  }

  const count = Number(options.count ?? config.copyTrading?.topWalletCount ?? 10);
  const mode = options.mode || config.copyTrading?.strategyMode || config.ranking?.strategyMode || "balanced";
  const topWallets = await getTopWalletEntries({ count, mode, forceRanking: !!options.forceRanking });
  if (!topWallets.length) {
    const summary = { wallets: 0, signals: 0, ignored: 0 };
    touchCopyRun(summary);
    return { ok: true, topWallets: [], signals: [], ignored: [], summary };
  }

  log("copy_engine", `Scanning ${topWallets.length} top wallet(s) for copyable DLMM positions`);
  const results = await Promise.allSettled(topWallets.map((entry) => evaluateWallet(entry, options)));
  const walletResults = results.map((r, i) => (
    r.status === "fulfilled"
      ? r.value
      : { wallet: topWallets[i]?.address, totalPositions: 0, signals: [], ignored: [], error: r.reason?.message || "unknown" }
  ));

  const signals = walletResults.flatMap((r) => r.signals || []);
  const ignored = walletResults.flatMap((r) => r.ignored || []);
  const summary = {
    wallets: topWallets.length,
    positions: walletResults.reduce((sum, r) => sum + Number(r.totalPositions || 0), 0),
    signals: signals.length,
    ignored: ignored.length,
    mode,
  };
  touchCopyRun(summary);

  if (config.copyTrading?.autoBlacklistOnCriticalDecay) {
    for (const entry of topWallets) {
      if (entry.score != null && Number(entry.score) < Number(config.copyTrading?.autoBlacklistScoreBelow ?? 20)) {
        tagWallet(entry.address, "auto_blacklist_decay");
      }
    }
  }

  log("copy_engine", `Scan complete: ${summary.signals} copy signal(s), ${summary.ignored} ignored`);
  return { ok: true, topWallets, walletResults, signals, ignored, summary };
}

export function getCopySignals(options = {}) {
  return getRecentCopySignals(options);
}
