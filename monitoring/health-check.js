/**
 * monitoring/health-check.js — System health monitoring
 *
 * Periodic checks:
 * - RPC responsiveness
 * - Wallet balance sufficiency
 * - Position count vs limits
 * - Cron job freshness
 * - Error rate tracking
 */

import { log } from "../logger.js";
import { HEALTH_STATUS } from "./types.js";

/**
 * Run full system health check.
 * @param {Object} context
 * @param {Object} context.positions — from state
 * @param {Object} context.wallet
 * @param {number} context.wallet.balance
 * @param {Object} context.lastCron
 * @param {number} context.lastCron.screening
 * @param {number} context.lastCron.management
 * @param {Object} context.config — runtime config
 * @returns {Promise<HealthCheckResult>}
 */
export async function runHealthCheck(context = {}) {
  const checks = [];
  const {
    positions = {},
    wallet = { balance: 0 },
    lastCron = { screening: 0, management: 0 },
    config: cfg = {},
  } = context;

  const now = Date.now() / 1000;
  const openPositions = Object.values(positions).filter(p => p && !p.closedAt);
  const maxPos = cfg.maxPositions ?? 5;

  // ── Check 1: Wallet balance ──
  const minBalance = cfg.gasReserve ?? 0.2;
  const walletOk = wallet.balance >= minBalance;
  checks.push({
    check: "wallet_balance",
    passed: walletOk,
    detail: walletOk
      ? `${wallet.balance} SOL ≥ ${minBalance} SOL`
      : `Low balance: ${wallet.balance} SOL < ${minBalance} SOL`,
  });

  // ── Check 2: Position count ──
  const posOk = openPositions.length <= maxPos;
  checks.push({
    check: "position_count",
    passed: posOk,
    detail: `${openPositions.length} open / ${maxPos} max`,
  });

  // ── Check 3: Cron freshness ──
  const screeningMinsAgo = lastCron.screening > 0 ? (now - lastCron.screening) / 60 : 999;
  const managementMinsAgo = lastCron.management > 0 ? (now - lastCron.management) / 60 : 999;
  const screeningOk = screeningMinsAgo < 60;
  const managementOk = managementMinsAgo < 20;
  checks.push({
    check: "cron_screening",
    passed: screeningOk,
    detail: screeningOk
      ? `${Math.round(screeningMinsAgo)}m ago`
      : `Stale: ${Math.round(screeningMinsAgo)}m ago`,
  });
  checks.push({
    check: "cron_management",
    passed: managementOk,
    detail: managementOk
      ? `${Math.round(managementMinsAgo)}m ago`
      : `Stale: ${Math.round(managementMinsAgo)}m ago`,
  });

  // ── Check 4: Consecutive errors ──
  const errorCount = context.consecutiveErrors ?? 0;
  const errorsOk = errorCount < 5;
  checks.push({
    check: "error_rate",
    passed: errorsOk,
    detail: errorsOk
      ? `${errorCount} consecutive errors`
      : `High error rate: ${errorCount} consecutive`,
  });

  // ── Check 5: OOR ratio ──
  const oorPositions = openPositions.filter(p => p.outOfRange);
  const oorRatio = openPositions.length > 0 ? oorPositions.length / openPositions.length : 0;
  const oorOk = oorRatio < 0.6;
  checks.push({
    check: "oor_ratio",
    passed: oorOk,
    detail: oorOk
      ? `${oorPositions.length}/${openPositions.length} OOR`
      : `High OOR: ${oorPositions.length}/${openPositions.length}`,
  });

  // ── Compute overall health ──
  const passedCount = checks.filter(c => c.passed).length;
  const healthScore = Math.round((passedCount / checks.length) * 100);
  const failedChecks = checks.filter(c => !c.passed);

  let status = HEALTH_STATUS.HEALTHY;
  if (failedChecks.length >= 2) status = HEALTH_STATUS.UNHEALTHY;
  else if (failedChecks.length >= 1) status = HEALTH_STATUS.DEGRADED;

  return {
    status,
    healthScore,
    checks,
    metrics: {
      uptimeHours: context.uptimeHours ?? 0,
      positionsOpen: openPositions.length,
      consecutiveErrors: errorCount,
      lastScreeningMinsAgo: Math.round(screeningMinsAgo),
      lastManagementMinsAgo: Math.round(managementMinsAgo),
      walletBalanceSol: wallet.balance,
      totalDeployedSol: openPositions.reduce((s, p) => s + (p.amountSol ?? 0), 0),
    },
  };
}

/**
 * Format health check result as text.
 * @param {HealthCheckResult} result
 * @returns {string}
 */
export function formatHealthCheck(result) {
  const emoji = result.status === HEALTH_STATUS.HEALTHY ? "✅"
    : result.status === HEALTH_STATUS.DEGRADED ? "⚠️"
    : "🔴";

  const lines = [
    `${emoji} <b>System Health: ${result.status.toUpperCase()}</b>`,
    `Health Score: ${result.healthScore}/100`,
    ``,
    `<b>── Checks ──</b>`,
    ...result.checks.map(c =>
      `${c.passed ? "✅" : "❌"} ${c.check}: ${c.detail ?? (c.passed ? "pass" : "fail")}`
    ),
    ``,
    `<b>── Metrics ──</b>`,
    `Uptime: ${result.metrics.uptimeHours}h`,
    `Open Positions: ${result.metrics.positionsOpen}`,
    `Consecutive Errors: ${result.metrics.consecutiveErrors}`,
    `Last Screening: ${result.metrics.lastScreeningMinsAgo}m ago`,
    `Last Management: ${result.metrics.lastManagementMinsAgo}m ago`,
    `Wallet: ${result.metrics.walletBalanceSol} SOL`,
    `Deployed: ${result.metrics.totalDeployedSol} SOL`,
  ];

  return lines.join("\n");
}
