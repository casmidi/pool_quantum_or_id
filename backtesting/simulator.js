/**
 * backtesting/simulator.js — Pool backtesting simulator
 *
 * Replays historical pool data to simulate LP performance.
 * Uses fee_active_tvl_ratio, volatility, and bin ranges to estimate returns.
 * Does NOT execute on-chain — purely computational.
 */

import { CLOSE_REASONS, TIMEFRAMES } from "./types.js";

/**
 * Run a backtest simulation on a pool.
 * @param {Object} pool — Pool data with historical snapshots
 * @param {Object} config — BacktestConfig
 * @returns {Promise<BacktestResult>}
 */
export async function runBacktest(pool, config) {
  const snapshots = (pool.snapshots || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  if (snapshots.length < 2) {
    return {
      poolName: pool.name || "unknown",
      totalDeployments: 0,
      totalCloses: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalFeesSol: 0,
      totalPnlSol: 0,
      avgPnlPerDeploy: 0,
      avgDurationMinutes: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      avgFeeTvlRatio: 0,
      positions: [],
      error: "Insufficient historical snapshots",
    };
  }

  const deployAmount = config.deployAmountSol || 0.5;
  const minScore = config.minScoreThreshold || 55;
  const positions = [];
  let balance = config.initialBalanceSol || 10;
  let peakBalance = balance;

  // Walk through snapshots, simulating deploy/hold/close cycles
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    const score = snapshot.poolScore ?? snapshot.score ?? 50;

    // Skip low-score snapshots
    if (score < minScore) continue;

    // Simulate deploy if we have funds and room
    if (balance >= deployAmount && positions.length < config.maxPositions) {
      const feeRatio = snapshot.fee_active_tvl_ratio ?? 0.02;
      const volatility = snapshot.volatility ?? 2;
      const binsBelow = config.minBinsBelow || 35;

      positions.push({
        poolAddress: pool.address || pool.pool_address || "",
        poolName: pool.name || "unknown",
        amountSol: deployAmount,
        binsBelow,
        deployBin: snapshot.active_bin || 0,
        lowerBin: (snapshot.active_bin || 0) - binsBelow,
        upperBin: (snapshot.active_bin || 0),
        deployTimestamp: snapshot.timestamp,
        closeTimestamp: 0,
        feesEarnedSol: 0,
        impermanentLossSol: 0,
        netPnlSol: 0,
        closeReason: 0,
      });

      balance -= deployAmount;
    }

    // Simulate fee accrual for open positions
    const minuteInterval = getMinuteInterval(config.timeframe || "5m");
    for (const pos of positions) {
      if (pos.closeTimestamp > 0) continue;

      const elapsedMinutes = (snapshot.timestamp - pos.deployTimestamp) / 60;
      const feeRatio = snapshot.fee_active_tvl_ratio ?? 0.02;
      // Scale fee accrual by time interval and TVL ratio
      const feeEarned = pos.amountSol * feeRatio * (minuteInterval / 1440); // daily scaling
      pos.feesEarnedSol += feeEarned;
      balance += feeEarned;

      // Check for OOR (out of range)
      if (snapshot.active_bin != null) {
        const activeBin = snapshot.active_bin;
        if (activeBin < pos.lowerBin || activeBin > pos.upperBin) {
          const oorMinutes = elapsedMinutes;
          if (oorMinutes >= config.outOfRangeWaitMinutes) {
            closePosition(pos, snapshot.timestamp, CLOSE_REASONS.OOR);
          }
        }
      }

      // Simulate IL based on price movement
      if (snapshot.price_change_pct != null && Math.abs(snapshot.price_change_pct) > 5) {
        pos.impermanentLossSol += pos.amountSol * (Math.abs(snapshot.price_change_pct) / 100) * 0.3;
      }
    }

    peakBalance = Math.max(peakBalance, balance + positions.reduce((s, p) => s + (p.closeTimestamp > 0 ? 0 : p.amountSol), 0));
  }

  // Close any remaining positions at end of simulation
  const endTs = snapshots[snapshots.length - 1].timestamp;
  for (const pos of positions) {
    if (pos.closeTimestamp === 0) {
      closePosition(pos, endTs, CLOSE_REASONS.MANUAL);
    }
  }

  // Calculate results
  const closed = positions.filter(p => p.closeTimestamp > 0);
  const wins = closed.filter(p => p.netPnlSol > 0);
  const losses = closed.filter(p => p.netPnlSol <= 0);
  const totalPnl = closed.reduce((s, p) => s + p.netPnlSol, 0);
  const totalFees = closed.reduce((s, p) => s + p.feesEarnedSol, 0);
  const maxDrawdown = peakBalance > 0 ? (1 - balance / peakBalance) * 100 : 0;
  const avgFeeTvl = snapshots.reduce((s, snap) => s + (snap.fee_active_tvl_ratio ?? 0), 0) / Math.max(1, snapshots.length);

  // Calculate Sharpe-like ratio
  const returns = closed.map(p => p.netPnlSol / p.amountSol);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.map(r => (r - avgReturn) ** 2).reduce((a, b) => a + b, 0) / (returns.length - 1)
    : 0;
  const sharpe = variance > 0 ? avgReturn / Math.sqrt(variance) * Math.sqrt(365) : 0;

  return {
    poolName: pool.name || "unknown",
    totalDeployments: positions.length,
    totalCloses: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    totalFeesSol: roundSol(totalFees),
    totalPnlSol: roundSol(totalPnl),
    avgPnlPerDeploy: closed.length > 0 ? roundSol(totalPnl / closed.length) : 0,
    avgDurationMinutes: closed.length > 0
      ? closed.reduce((s, p) => s + (p.closeTimestamp - p.deployTimestamp) / 60, 0) / closed.length
      : 0,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    avgFeeTvlRatio: Math.round(avgFeeTvl * 10000) / 10000,
    positions: closed,
  };
}

/**
 * Backtest a set of pools and return ranked results.
 * @param {Array<Object>} pools
 * @param {BacktestConfig} config
 * @returns {Promise<Array<BacktestResult>>}
 */
export async function backtestPools(pools, config) {
  const results = [];
  for (const pool of pools) {
    try {
      const result = await runBacktest(pool, config);
      results.push(result);
    } catch (err) {
      results.push({
        poolName: pool.name || "unknown",
        totalDeployments: 0,
        totalCloses: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalFeesSol: 0,
        totalPnlSol: 0,
        avgPnlPerDeploy: 0,
        avgDurationMinutes: 0,
        maxDrawdown: 0,
        sharpeRatio: 0,
        avgFeeTvlRatio: 0,
        positions: [],
        error: err.message,
      });
    }
  }

  // Sort by win rate, then by total PnL
  results.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.totalPnlSol - a.totalPnlSol;
  });

  return results;
}

// ── Helpers ──

function closePosition(pos, timestamp, reason) {
  const totalFees = pos.feesEarnedSol;
  const totalIl = pos.impermanentLossSol;
  pos.closeTimestamp = timestamp;
  pos.closeReason = reason;
  pos.netPnlSol = roundSol(totalFees - totalIl);
}

function getMinuteInterval(timeframe) {
  return TIMEFRAMES[timeframe]?.minutes ?? 5;
}

function roundSol(amount) {
  return Math.round(amount * 1e9) / 1e9;
}
