/**
 * monitoring/dashboard-reports.js — Performance & dashboard report generator
 *
 * Aggregates position performance, pool stats, and wallet metrics
 * into human-readable reports for Telegram/CLI.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { getTrackedPositions } from "../state.js";
import { REPORT_PERIODS } from "./types.js";

/**
 * Build a dashboard performance report.
 * @param {Object} [opts]
 * @param {string} [opts.period="all"]
 * @param {Array} [opts.positionHistory] — from state or lessons
 * @param {Object} [opts.walletStats]
 * @returns {Promise<DashboardReport>}
 */
export async function generateReport(opts = {}) {
  const {
    period = REPORT_PERIODS.ALL,
    positionHistory = [],
    walletStats = {},
  } = opts;

  const positions = await getTrackedPositions?.() || [];
  const allPositions = positionHistory.length > 0 ? positionHistory : positions;

  const closed = allPositions.filter(p => p.closedAt);
  const active = allPositions.filter(p => !p.closedAt);

  // Filter by period
  const cutoff = getPeriodCutoff(period);
  const filtered = cutoff > 0 ? closed.filter(p => p.closedAt >= cutoff) : closed;

  const pnlValues = filtered.map(p => p.netPnlSol ?? p.pnl ?? 0);
  const totalPnl = pnlValues.reduce((s, v) => s + v, 0);
  const wins = pnlValues.filter(v => v > 0);
  const losses = pnlValues.filter(v => v <= 0);

  // Top/bottom pools
  const poolPnL = {};
  filtered.forEach(p => {
    const name = p.poolName || p.pool_address?.slice(0, 8) || "unknown";
    poolPnL[name] = (poolPnL[name] || 0) + (p.netPnlSol ?? p.pnl ?? 0);
  });
  const sortedPools = Object.entries(poolPnL)
    .map(([name, pnl]) => ({ name, pnl }))
    .sort((a, b) => b.pnl - a.pnl);

  // Recent events
  const recentEvents = [...filtered]
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 10)
    .map(p => ({
      pool: p.poolName || p.pool_address?.slice(0, 8),
      pnl: p.netPnlSol ?? p.pnl ?? 0,
      duration: p.durationMinutes,
      reason: p.closeReason,
      timestamp: p.closedAt,
    }));

  // Risk metrics
  const exposurePct = walletStats.totalDeployed && walletStats.balance
    ? (walletStats.totalDeployed / walletStats.balance) * 100
    : 0;

  return {
    timestamp: new Date().toISOString(),
    period,
    summary: {
      totalDeployments: filtered.length,
      activePositions: active.length,
      totalPnlSol: roundSol(totalPnl),
      winRate: filtered.length > 0 ? (wins.length / filtered.length) * 100 : 0,
      totalFeesSol: roundSol(filtered.reduce((s, p) => s + (p.feesEarnedSol ?? 0), 0)),
      avgDurationMinutes: filtered.length > 0
        ? filtered.reduce((s, p) => s + (p.durationMinutes ?? 0), 0) / filtered.length
        : 0,
      bestPoolPnl: sortedPools[0]?.pnl ?? 0,
      worstPoolPnl: sortedPools[sortedPools.length - 1]?.pnl ?? 0,
    },
    topPools: sortedPools.slice(0, 5),
    recentEvents,
    risk: {
      exposurePct: Math.round(exposurePct * 10) / 10,
      consecutiveOor: walletStats.consecutiveOor ?? 0,
      dailyPnlUsd: walletStats.dailyPnlUsd ?? 0,
    },
    warnings: generateWarnings(active, walletStats),
  };
}

/**
 * Format a report as a Telegram-friendly HTML string.
 * @param {DashboardReport} report
 * @returns {string}
 */
export function formatReportHtml(report) {
  const { summary, topPools, recentEvents, risk, warnings } = report;

  const lines = [
    `<b>📊 Meridian Performance Report</b>`,
    `<b>Period:</b> ${report.period}`,
    ``,
    `<b>── Summary ──</b>`,
    `Deployments: ${summary.totalDeployments} (${summary.activePositions} active)`,
    `Total PnL: <b>${summary.totalPnlSol >= 0 ? "+" : ""}${summary.totalPnlSol} SOL</b>`,
    `Win Rate: ${summary.winRate.toFixed(1)}%`,
    `Total Fees: ${summary.totalFeesSol} SOL`,
    `Avg Duration: ${Math.round(summary.avgDurationMinutes)}m`,
    `Best Pool: +${summary.bestPoolPnl} SOL`,
    `Worst Pool: ${summary.worstPoolPnl} SOL`,
    ``,
  ];

  if (topPools.length > 0) {
    lines.push(`<b>── Top Pools ──</b>`);
    topPools.slice(0, 3).forEach(p => {
      lines.push(`${p.name}: <b>${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(4)} SOL</b>`);
    });
    lines.push(``);
  }

  lines.push(`<b>── Risk ──</b>`);
  lines.push(`Exposure: ${risk.exposurePct}%`);
  lines.push(`Consecutive OOR: ${risk.consecutiveOor}`);
  lines.push(`Daily PnL: ${risk.dailyPnlUsd >= 0 ? "+" : ""}${risk.dailyPnlUsd} USD`);
  lines.push(``);

  if (warnings.length > 0) {
    lines.push(`<b>⚠️ Warnings</b>`);
    warnings.forEach(w => lines.push(`• ${w}`));
    lines.push(``);
  }

  if (recentEvents.length > 0) {
    lines.push(`<b>── Recent Closes ──</b>`);
    recentEvents.slice(0, 5).forEach(e => {
      lines.push(`${e.pool}: ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(4)} SOL`);
    });
  }

  return lines.join("\n");
}

/**
 * Generate active warnings based on current state.
 * @param {Array} activePositions
 * @param {Object} walletStats
 * @returns {string[]}
 */
function generateWarnings(activePositions, walletStats) {
  const warnings = [];

  if ((walletStats.consecutiveOor ?? 0) >= 2) {
    warnings.push(`${walletStats.consecutiveOor} consecutive OOR closes — consider pausing deploys`);
  }
  if ((walletStats.exposurePct ?? 0) > 50) {
    warnings.push(`Portfolio exposure at ${walletStats.exposurePct.toFixed(1)}% — high concentration risk`);
  }
  if (activePositions.length === 0 && (walletStats.totalDeployed ?? 0) > 0) {
    warnings.push(`All positions closed but deployed SOL not fully recovered`);
  }

  return warnings;
}

function getPeriodCutoff(period) {
  const now = Date.now() / 1000;
  switch (period) {
    case REPORT_PERIODS.DAILY: return now - 86400;
    case REPORT_PERIODS.WEEKLY: return now - 604800;
    case REPORT_PERIODS.MONTHLY: return now - 2592000;
    default: return 0;
  }
}

function roundSol(amount) {
  return Math.round(amount * 1e9) / 1e9;
}
