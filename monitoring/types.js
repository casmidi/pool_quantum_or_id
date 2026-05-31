/**
 * monitoring/types.js — Monitoring system type definitions
 */

/**
 * @typedef {Object} HealthCheckResult
 * @property {string} status — "healthy" | "degraded" | "unhealthy"
 * @property {number} healthScore — 0-100
 * @property {Array<{check:string, passed:boolean, detail?:string}>} checks
 * @property {Object} metrics
 * @property {number} metrics.uptimeHours
 * @property {number} metrics.positionsOpen
 * @property {number} metrics.consecutiveErrors
 * @property {number} metrics.lastScreeningMinsAgo
 * @property {number} metrics.lastManagementMinsAgo
 * @property {number} metrics.walletBalanceSol
 * @property {number} metrics.totalDeployedSol
 */

/**
 * @typedef {Object} DashboardReport
 * @property {string} timestamp
 * @property {string} period — "daily" | "weekly" | "monthly" | "all"
 * @property {Object} summary
 * @property {number} summary.totalDeployments
 * @property {number} summary.activePositions
 * @property {number} summary.totalPnlSol
 * @property {number} summary.winRate
 * @property {number} summary.totalFeesSol
 * @property {number} summary.avgDurationMinutes
 * @property {number} summary.bestPoolPnl
 * @property {number} summary.worstPoolPnl
 * @property {Array<Object>} topPools — ranked by PnL
 * @property {Array<Object>} recentEvents — last 10 events
 * @property {Object} risk
 * @property {number} risk.exposurePct
 * @property {number} risk.consecutiveOor
 * @property {number} risk.dailyPnlUsd
 */

export const HEALTH_STATUS = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
};

export const REPORT_PERIODS = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  ALL: "all",
};
